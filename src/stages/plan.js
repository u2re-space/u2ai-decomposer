/**
 * @file src/stages/plan.js
 * @module stages/plan
 * @purpose The mini-plan of a run: the stages, their order, their parameters and the stages that
 *          are left out.
 *
 *   The pipeline of the decomposer is not fixed any more. The reception reads the task and the
 *   reference and answers with the plan of the work: which stages run, in what order, and with
 *   which parameters. A stage the plan does not name does not run, and a stage the plan names
 *   with different parameters runs with them.
 *
 *   The plan is not the whim of the model. The rules of the house hold:
 *
 *   - the stage that cuts the screens (`decompose`) and the stage that writes the answer
 *     (`resolve`) are always there: without them there is nothing to continue from and nothing
 *     to deliver;
 *   - the stages that work on the screens come after the stage that cuts them;
 *   - the stage that writes the answer comes last;
 *   - the layer split happens only when somebody asked for it — the prompt says so, or the
 *     config says so, or the flag `--advanced` says so. A plan that asks for the layers on its
 *     own is refused.
 *
 * @depends none
 * @usedBy stages/reception, stages/index, shared/pipeline
 * @exports PLAN_FILE, MANDATORY_STAGES, STAGE_PARAMS, normalizePlan, defaultPlan,
 *          mentionsLayers, applyPlan, planOrder
 * @ai.tags stages, plan, pipeline
 * @ai.hint pure
 */

/** The name of the file of the plan inside the work directory. */
export const PLAN_FILE = 'plan.json';

/** The stages every run has: the one that cuts the screens and the one that writes the answer. */
export const MANDATORY_STAGES = Object.freeze(['decompose', 'resolve']);

/**
 * The parameters a stage accepts from the plan.
 *
 * The table is the contract: a parameter that is not in it is not applied, and a value that is
 * not one of the allowed ones is dropped with a warning. The model does not get to set
 * `maxTurns` of a stage — the turns are the budget of the house, not of the plan.
 * @type {Readonly<Record<string, Readonly<Record<string, object>>>>}
 */
export const STAGE_PARAMS = Object.freeze({
    extend: Object.freeze({
        quality: Object.freeze({ type: 'enum', values: Object.freeze(['low', 'medium', 'high']) }),
    }),
    decompose: Object.freeze({
        mode: Object.freeze({ type: 'enum', values: Object.freeze(['agent', 'inline']) }),
    }),
    rectify: Object.freeze({
        mode: Object.freeze({ type: 'enum', values: Object.freeze(['geometry', 'ai-mode']) }),
    }),
    reconstruct: Object.freeze({
        quality: Object.freeze({ type: 'enum', values: Object.freeze(['low', 'medium', 'high']) }),
        maxPasses: Object.freeze({ type: 'number', min: 1, max: 10 }),
    }),
    overlap: Object.freeze({
        quality: Object.freeze({ type: 'enum', values: Object.freeze(['low', 'medium', 'high']) }),
    }),
    resolve: Object.freeze({
        layers: Object.freeze({ type: 'boolean' }),
    }),
});

/**
 * The text of a value: the plan is written by a model, and a model writes numbers as strings
 * from time to time.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function text(value) {
    return typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());
}

/**
 * Does the task ask for the layers of a screen?
 *
 * The split of a screen into layers is expensive and it changes the shape of the delivery, so
 * it happens only when the words of the task ask for it. Both languages of the house are read:
 * the task of a user is written in Russian as often as in English. The Russian words are written
 * as escapes: the code of the house is English, and a file of this package carries no letters
 * outside the Latin alphabet.
 * @param {string} prompt
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function mentionsLayers(prompt) {
    const text_ = String(prompt ?? '');
    if (!text_.trim()) return false;
    if (/\blayers?\b/i.test(text_)) return true;
    if (/\blayered\b/i.test(text_)) return true;
    if (/\u043f\u043e\u0441\u043b\u043e\u0439\u043d/i.test(text_)) return true;
    return /\u0441\u043b\u043e[\u0438\u0439\u044f\u0435]/i.test(text_);
}

/**
 * The parameters of one step of the plan, checked against the table of the stage.
 * @param {string} stage the id of the stage
 * @param {unknown} raw the parameters the model wrote
 * @param {string[]} warnings the warnings of the run
 * @returns {Record<string, unknown>}
 * @ai.hint pure
 */
function normalizeParams(stage, raw, warnings) {
    const table = STAGE_PARAMS[stage] ?? {};
    const out = {};
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const [key, value] of Object.entries(source)) {
        const spec = table[key];
        if (!spec) {
            warnings.push(`The plan sets an unknown parameter of ${stage}: ${key}`);
            continue;
        }
        if (spec.type === 'boolean') {
            if (typeof value === 'boolean') out[key] = value;
            else if (value === 'true') out[key] = true;
            else if (value === 'false') out[key] = false;
            else warnings.push(`The plan sets ${stage}.${key} to something that is not true or false`);
            continue;
        }
        if (spec.type === 'number') {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                warnings.push(`The plan sets ${stage}.${key} to something that is not a number`);
                continue;
            }
            if (number < spec.min || number > spec.max) {
                warnings.push(`The plan sets ${stage}.${key} to ${number}, which is out of range`);
                continue;
            }
            out[key] = Math.round(number);
            continue;
        }
        // The enum: the value has to be one of the allowed ones, letter for letter.
        const value_ = text(value);
        if (!spec.values.includes(value_)) {
            warnings.push(`The plan sets ${stage}.${key} to "${value_}", which is not one of ${spec.values.join(', ')}`);
            continue;
        }
        out[key] = value_;
    }
    return out;
}

/**
 * The order of the steps of the plan, with the rules of the house applied.
 *
 * The order the model wrote is kept — the stages that work on the screens may run before the
 * stage that rectifies them, and the fallbacks of the stages cover it. Two rules are not
 * negotiable: the stage that cuts the screens comes before the stages that work on the
 * screens, and the stage that writes the answer comes last.
 * @param {object[]} steps the steps of the plan
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function planOrder(steps = []) {
    const list = Array.isArray(steps) ? [...steps] : [];
    const indexOf = (id) => list.findIndex((step) => step.stage === id);

    // The answer comes last: it is written from what the other stages left on the disk.
    const resolveAt = indexOf('resolve');
    if (resolveAt >= 0 && resolveAt !== list.length - 1) {
        const [resolve] = list.splice(resolveAt, 1);
        list.push(resolve);
    }

    // The screens come from the stage that cuts them: a stage that works on the screens waits.
    const decomposeAt = indexOf('decompose');
    if (decomposeAt >= 0) {
        const consumers = ['rectify', 'reconstruct', 'overlap']
            .map((id) => indexOf(id))
            .filter((at) => at >= 0);
        const firstConsumer = consumers.length ? Math.min(...consumers) : -1;
        if (firstConsumer >= 0 && decomposeAt > firstConsumer) {
            const [decompose] = list.splice(decomposeAt, 1);
            list.splice(firstConsumer, 0, decompose);
        }
    }
    return list;
}

/**
 * The plan of a run, checked and put in order.
 *
 * The answer of the model is a draft: the stages it does not know are dropped, the stages it
 * names twice are kept once, the parameters are checked against the table, the mandatory
 * stages are added and the order is put right. What comes out is the plan the run follows.
 * @param {object} answer the answer of the reception role
 * @param {{ stages?: string[], prompt?: string }} [options]
 * @returns {{ plan: object, warnings: string[] }}
 * @exports
 * @ai.hint pure
 */
export function normalizePlan(answer, { stages = [], prompt = '' } = {}) {
    const warnings = [];
    const known = new Set(Array.isArray(stages) ? stages : []);
    const steps = [];
    const seen = new Set();

    for (const raw of Array.isArray(answer?.steps) ? answer.steps : []) {
        const stage = text(raw?.stage);
        if (!known.has(stage)) {
            warnings.push(`The plan names an unknown stage: ${stage || '(empty)'}`);
            continue;
        }
        if (seen.has(stage)) {
            warnings.push(`The plan names the stage ${stage} twice — the first one is kept`);
            continue;
        }
        seen.add(stage);
        steps.push({
            stage,
            why: text(raw?.why),
            params: normalizeParams(stage, raw?.params, warnings),
        });
    }

    // The stage that cuts the screens is always there. It goes before the stage that cuts the
    // frame, when the plan has one: the frame is grown before the screens are cut out of it.
    if (!seen.has('decompose') && known.has('decompose')) {
        const at = seen.has('extend') ? steps.findIndex((step) => step.stage === 'extend') + 1 : 0;
        steps.splice(at, 0, { stage: 'decompose', why: 'the stage every run needs', params: {} });
        warnings.push('The plan left out decompose — the stage that cuts the screens is always there');
        seen.add('decompose');
    }

    // The stage that writes the answer is always there, and it comes last.
    if (!seen.has('resolve') && known.has('resolve')) {
        steps.push({ stage: 'resolve', why: 'the stage every run needs', params: {} });
        warnings.push('The plan left out resolve — the stage that writes the answer is always there');
        seen.add('resolve');
    }

    const skipped = [];
    for (const raw of Array.isArray(answer?.skipped) ? answer.skipped : []) {
        const stage = text(raw?.stage);
        if (!known.has(stage)) continue;
        skipped.push({ stage, why: text(raw?.why) });
    }

    const ordered = planOrder(steps);
    const names = ordered.map((step) => step.stage);
    for (const stage of known) {
        if (names.includes(stage)) continue;
        if (skipped.some((item) => item.stage === stage)) continue;
        skipped.push({ stage, why: 'the plan does not name it' });
    }

    return {
        plan: {
            summary: text(answer?.summary),
            prompt: String(prompt ?? ''),
            steps: ordered,
            skipped,
            notes: Array.isArray(answer?.notes) ? answer.notes.map(text).filter(Boolean) : [],
        },
        warnings,
    };
}

/**
 * The plan of a run that nobody planned: every stage, in the usual order, with the settings of
 * the config.
 *
 * It is the plan of the fallback: the reception failed, or the run was told to work without a
 * plan. The work still has to be done.
 * @param {string[]} stages the ids of the stages
 * @param {string} [prompt] the task of the run
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function defaultPlan(stages = [], prompt = '') {
    return {
        summary: 'The usual work: every stage, in the usual order.',
        prompt: String(prompt ?? ''),
        steps: (Array.isArray(stages) ? stages : []).map((stage) => ({ stage, why: '', params: {} })),
        skipped: [],
        notes: [],
    };
}

/**
 * The config of the run with the parameters of the plan applied.
 *
 * The config of the user is not touched: the run gets its own copy of the settings of the
 * stages, and the plan writes into that copy.
 * @param {object} config the config of the run
 * @param {object} plan the plan of the run
 * @param {{ layersAllowed?: boolean }} [options]
 * @returns {{ config: object, warnings: string[] }}
 * @exports
 * @ai.hint pure
 */
export function applyPlan(config, plan, { layersAllowed = false } = {}) {
    const warnings = [];
    const stages = { ...(config?.stages ?? {}) };
    for (const [id, settings] of Object.entries(stages)) stages[id] = { ...settings };

    for (const step of Array.isArray(plan?.steps) ? plan.steps : []) {
        const id = text(step?.stage);
        const params = step?.params ?? {};
        for (const [key, value] of Object.entries(params)) {
            // The layer split is not the plan's decision: somebody has to ask for it.
            if (id === 'resolve' && key === 'layers' && value === true && !layersAllowed) {
                warnings.push('The plan asks for the layer split, but nobody asked for it — the split is not done');
                continue;
            }
            stages[id] = { ...(stages[id] ?? {}), [key]: value };
        }
    }

    return { config: { ...(config ?? {}), stages }, warnings };
}
