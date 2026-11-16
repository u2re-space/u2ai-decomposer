/**
 * @file src/stages/reception.js
 * @module stages/reception
 * @purpose The reception of a run: it reads the task and the reference and answers with the plan
 *          of the work — the stages, their order and their parameters.
 *
 *   The reception is the first thing a run does that nobody planned. It looks at the picture and
 *   at the task and decides what is going to be done to it: which stages run, in what order and
 *   with which parameters. A stage the plan does not name does not run.
 *
 *   The plan is checked before it is followed (`stages/plan.js`): the stages that every run
 *   needs are added back, the stages that do not exist are dropped, the parameters are checked
 *   against the table of the house and the order is put right.
 *
 *   The reception is not a stage of the pipeline: it runs before the pipeline and it does not
 *   appear in the plan it writes.
 *
 * @depends node:path, node:fs/promises, agent/schemas, image/sizing, stages/index, stages/plan
 * @usedBy shared/pipeline
 * @exports runReception, receptionCatalogue, RECEPTION_TOOLS
 * @ai.tags stages, plan, reception
 * @ai.hint io
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PLAN_SCHEMA } from '../agent/schemas.js';
import { downscaleToMaxSide } from '../image/sizing.js';
import { imagePart } from '../openai/responses.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { toPosix } from '../agent/paths.js';
import { STAGE_DEFS, STAGE_IDS } from './index.js';
import { STAGE_PARAMS, defaultPlan, normalizePlan } from './plan.js';

/** The reception plans the work and does not do it: it gets no tools at all. */
export const RECEPTION_TOOLS = Object.freeze([]);

/**
 * The catalogue of the stages, as the reception reads it.
 *
 * Every stage is named with its id, with a line about what it is for and with the parameters it
 * accepts. The ids are the contract: the plan names a stage by its id, and the run looks the id
 * up in the registry.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function receptionCatalogue() {
    const stages = STAGE_DEFS.map((stage) => `- ${stage.id} — ${stage.about}`).join('\n');
    const params = Object.entries(STAGE_PARAMS).map(([id, table]) => {
        const list = Object.entries(table).map(([key, spec]) => {
            if (spec.type === 'enum') return `${key}: ${spec.values.join(' | ')}`;
            if (spec.type === 'number') return `${key}: ${spec.min}..${spec.max}`;
            return `${key}: true | false`;
        }).join(', ');
        return `- ${id}: ${list}`;
    }).join('\n');
    return `The stages of the house:\n${stages}\n\nThe parameters a stage accepts:\n${params}`;
}

/**
 * Run the reception: ask for the plan of the work and check it.
 *
 * The answer of the role is a draft, and the rules of the house are applied to it before the run
 * follows it. When the role answers nothing, the run falls back to the usual work: every stage,
 * in the usual order, with the settings of the config.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<object>} the plan of the run
 * @exports
 * @ai.hint io
 */
export async function runReception(state, notify = () => {}) {
    const { root, workDir, config, roles, model, effort, warnings } = state;
    const prompt = String(state.prompt ?? '').trim();
    const settings = config?.plan ?? {};
    const engine = config?.raster?.engine ?? 'auto';

    // The reference goes with the question: the picture says what the work is. The original
    // pictures are used here — the run has not cut anything out of them yet.
    const sources = Array.isArray(state.references) && state.references.length
        ? state.references
        : (Array.isArray(state.images) ? state.images : []);
    const parts = [];
    const names = [];
    for (const image of sources) {
        const absolute = path.resolve(root, image);
        let bytes;
        try {
            bytes = await readFile(absolute);
        } catch {
            warnings.push(`reception: cannot read ${image}`);
            continue;
        }
        try {
            const copy = await downscaleToMaxSide(bytes, {
                maxSide: config?.image?.maxSide ?? null,
                maxMegapixels: config?.image?.maxMegapixels ?? null,
                engine,
            });
            parts.push(imagePart(copy.bytes, sniffImage(copy.bytes).mime));
            names.push(toPosix(path.relative(root, absolute)));
        } catch (error) {
            warnings.push(`reception: ${image} was not sent to the model (${error?.message ?? error})`);
        }
    }

    // The reception can only pick a mode of the rectify stage that the run is able to serve.
    const editor = state.imageModel
        || state.config?.imageModel
        || imageModelFor(state.config, { hasImage: Boolean(state.client?.images) });
    const pictureModel = Boolean(state.client?.images) && Boolean(editor);
    const text = [
        prompt
            ? `Task: ${prompt}`
            : 'Task: none was given. The picture alone has to say what is going to be done to it.',
        '',
        receptionCatalogue(),
        '',
        names.length
            ? `The reference of the run: ${names.join(', ')}.`
            : 'There is no readable reference: plan for the work that does not need one.',
        editor && pictureModel
            ? `The picture model of the run: ${editor}. The ai-mode of the rectify stage is possible.`
            : 'There is no picture model in this run: the ai-mode of the rectify stage is not possible, '
                + 'the geometry mode is the one that may be chosen.',
    ].join('\n');

    const result = await roles.run('reception', {
        text,
        parts,
        schema: PLAN_SCHEMA,
        schemaName: 'plan',
        maxTurns: Number.isSafeInteger(settings.maxTurns) ? settings.maxTurns : 4,
        model,
        effort,
        extraTools: [...RECEPTION_TOOLS],
    });

    let plan = null;
    // The answer of the role is the plan: either the JSON of the message or the arguments of
    // the schema call.
    const draft = result?.data
        ?? result?.toolCalls?.find((call) => call.name === 'plan')?.arguments
        ?? null;
    if (draft) {
        const checked = normalizePlan(draft, { stages: STAGE_IDS, prompt });
        plan = checked.plan;
        for (const message of checked.warnings) warnings.push(`reception: ${message}`);
    } else {
        warnings.push(`reception: the role returned no plan (${result?.status ?? 'unknown'}) — the usual work is done`);
        plan = defaultPlan(STAGE_IDS, prompt);
    }

    notify({
        type: 'reception.done',
        summary: plan.summary,
        stages: plan.steps.map((step) => step.stage),
    });
    return plan;
}
