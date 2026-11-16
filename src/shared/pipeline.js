/**
 * @file src/shared/pipeline.js
 * @module shared/pipeline
 * @purpose Pipeline orchestrator: asks for the plan of the run, runs the stages in the order
 *          that plan names, and passes artifacts between them.
 *
 *   The order of the stages is not fixed any more. A run that was not told which stages to run
 *   asks the reception first: it reads the task and the reference and answers with the stages,
 *   their order and their parameters. A run that was told (`--stages`) follows the list it was
 *   given. The plan of a run is written to `decomposition/plan.json`, so the run that follows
 *   it and the run that continues it read the same one.
 *
 * @depends node:path, node:fs/promises, node:crypto, shared/manifest, shared/resume, shared/house,
 *   stages/plan, stages/reception
 * @exports STAGES, runPipeline, runStages, newRunId
 * @ai.tags pipeline, stages
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRoleRunner } from '../roles/index.js';
import { createToolset } from '../agent/tools.js';
import { loadSkills } from '../agent/skills.js';
import { connectMcpServers } from '../agent/mcp.js';
import { STAGE_DEFS, STAGE_DIRS, STAGE_ROLES } from '../stages/index.js';
import { DECOMPOSITION_FILE } from '../stages/resolve.js';
import { publishDelivery } from '../stages/publish.js';
import { BATCH_SUBMITTED } from '../openai/batch.js';
import { saveStageManifest } from './manifest.js';
import { resumeFromWorkDir } from './resume.js';
import { runStateDir, writeFileAtomic } from './house.js';
import { runReception } from '../stages/reception.js';
import { PLAN_FILE, applyPlan, defaultPlan, mentionsLayers } from '../stages/plan.js';

/**
 * Ordered stage definitions.
 * @type {Array<{ id: string, label: string, run: Function }>}
 */
export const STAGES = STAGE_DEFS.map((stage) => ({
    id: stage.id,
    label: stage.label,
    run: stage.run,
}));

/**
 * The id of a run: the time and a few random bytes, in a name a person can read.
 *
 * The id names the state of the run inside the house of the project: `.ai/tmp/<run-id>/`.
 * The state dies with the run, and a new run never reads the state of the old one.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function newRunId() {
    return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * The stage of this id, or null.
 * @param {string} id
 * @returns {{ id: string, label: string, run: Function }|null}
 * @ai.hint pure
 */
function stageOf(id) {
    return STAGES.find((stage) => stage.id === id) ?? null;
}

/**
 * Write the plan of the run next to the artifacts it describes.
 *
 * The plan is a file of the run: the reader may want to know why a stage was skipped, and the
 * run that continues this one reads the same plan.
 * @param {string} root the root of the project
 * @param {string} workDir the delivery directory of the run, relative to the root
 * @param {object} plan the plan of the run
 * @returns {Promise<string>} the path of the plan, relative to the root
 * @ai.hint io
 */
async function writePlan(root, workDir, plan) {
    const planPath = path.resolve(root, workDir, PLAN_FILE);
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    return path.relative(root, planPath).split(path.sep).join('/');
}

/**
 * Execute the pipeline stages in order.
 * @param {{
 *   root: string, images: string[], outDir: string, stages: string[]|null,
 *   config: object, client: object, model?: string|null, effort?: string|null,
 *   imageModel?: string|null, advanced?: boolean, stopAfter?: string|null,
 *   dryRun?: boolean, prompt?: string, notify?: (event: object) => void
 * }} opts
 *   `stages: null` means the run decides the stages by itself: the reception answers with the
 *   plan of the work.
 * @returns {Promise<{ output: object, warnings: string[] }>}
 */
export async function runPipeline({
    root, images, outDir = '.', stages: requestedStages,
    config, client, model = null, effort = null, imageModel = null,
    advanced = false, stopAfter = null, dryRun = false, prompt = '', notify = () => {},
}) {
    const skills = {};
    for (const role of ['reception', 'extender', 'decomposer', 'rectifier', 'restorer', 'overlap', 'director']) {
        const packs = await loadSkills({ dir: config?.skills?.dir ?? null, role });
        if (packs.length) {
            skills[role] = packs
                .map((pack) => `## Skill pack: ${pack.name}\n${pack.content.trim()}`)
                .join('\n\n');
        }
    }

    const mcp = dryRun ? [] : await connectMcpServers(config?.mcp?.servers ?? []);

    // One toolset for the whole run: the stages open the directories a role may write into, and
    // the role runner executes the calls with the very same executor.
    const toolset = createToolset({ root, config, client, mcp });

    const roles = createRoleRunner({
        client,
        config,
        model,
        effort,
        toolset,
        skills,
        onEvent: (event) => notify({ type: 'api', ...event }),
    });
    const workDir = path.join(outDir, 'decomposition');
    if (!dryRun) await mkdir(workDir, { recursive: true });

    // The state of the run lives in the house of the project — `.ai/tmp/<run-id>/` — and dies
    // with the run. The scratch of the stages lives there too: a scratch directory is the
    // state of a run, not a part of the delivery.
    const runId = newRunId();
    const scratchDir = runStateDir(root, runId, config);
    if (!dryRun) await mkdir(scratchDir, { recursive: true });

    // Shared state passed between stages.
    const state = {
        root,
        images,
        // The pictures the run started from. The stages replace `images` with their own files, but
        // the reference stays: it is the ground truth of a collage, and the stage that cuts the
        // collage works on it.
        references: [...images],
        workDir,
        outDir,
        // The id of the run and the directory of its state: the scratch of the stages.
        runId,
        scratchDir,
        config,
        client,
        roles,
        model,
        effort,
        imageModel,
        advanced,
        dryRun,
        // The task of the run: the text the reception reads and the plan is made of.
        prompt: String(prompt ?? ''),
        // The plan of the run, filled in below.
        plan: null,
        extended: [],
        canvas: [],
        screens: [],
        screensFiles: [],
        toolset,
        rectified: [],
        restored: [],
        overlapResolved: [],
        // The ai-mode of the rectify stage cleans the overlap inside itself: the stage of the
        // pipeline sees the flag and does not pay for the same work twice.
        overlapCleanedInAiMode: false,
        decomposition: null,
        warnings: [],
    };

    // --- the plan of the run ------------------------------------------------------
    // A run that was told which stages to run follows that list. A run that was not asks the
    // reception: it reads the task and the reference and answers with the plan of the work.
    const planned = !Array.isArray(requestedStages);
    let plan = null;
    if (planned && !dryRun && config?.plan?.enabled !== false) {
        try {
            plan = await runReception(state, notify);
        } catch (error) {
            state.warnings.push(`reception: ${error?.message ?? error}`);
        }
    }
    if (!plan) {
        const ids = planned
            ? STAGES.map((stage) => stage.id).filter((id) => config?.stages?.[id]?.enabled !== false)
            : requestedStages;
        plan = defaultPlan(ids, state.prompt);
    }
    state.plan = plan;

    // The parameters of the plan go into the copy of the settings of this run: the config of
    // the user is not touched.
    const layersAllowed = Boolean(
        advanced
        || config?.stages?.resolve?.layers === true
        || mentionsLayers(state.prompt),
    );
    const applied = applyPlan(config, plan, { layersAllowed });
    state.config = applied.config;
    for (const message of applied.warnings) state.warnings.push(`plan: ${message}`);

    // --- the stages of the run ----------------------------------------------------
    let toRun;
    if (planned) {
        toRun = plan.steps
            .map((step) => stageOf(step.stage))
            .filter(Boolean)
            .filter((stage) => config?.stages?.[stage.id]?.enabled !== false);
    } else {
        toRun = STAGES.filter((stage) => (
            requestedStages.includes(stage.id)
            && config?.stages?.[stage.id]?.enabled !== false
        ));
    }
    if (stopAfter) {
        const stopIdx = toRun.findIndex((s) => s.id === stopAfter);
        if (stopIdx >= 0) toRun.length = stopIdx + 1;
    }

    // --- the dry run ---------------------------------------------------------------
    if (dryRun) {
        const outputs = toRun.map((stage) => (
            stage.id === 'resolve'
                ? path.join(outDir, DECOMPOSITION_FILE)
                : path.join(workDir, STAGE_DIRS[stage.id] ?? stage.id)
        ));
        notify({
            type: 'plan',
            images,
            // The reception is not called in a dry run: it costs a call, and the dry run exists
            // to show the shape of the work without paying for it.
            dynamic: planned,
            stages: toRun.map((stage) => {
                const role = roles.resolve(STAGE_ROLES[stage.id]);
                return {
                    id: stage.id,
                    label: stage.label,
                    model: role.model,
                    imageModel: role.imageModel ?? imageModel ?? config?.imageModel ?? null,
                    // The layer split is a route of its own: its model is worth showing.
                    layerModel: (advanced && stage.id === 'resolve')
                        ? (config?.stages?.resolve?.layerModel ?? null)
                        : null,
                };
            }),
            outputs,
        });
        return { output: null, warnings: [], failed: false };
    }

    // The plan is written down before the first stage runs: the reader may want to know what
    // the run is going to do, and the run that continues this one reads the same file.
    const planPath = await writePlan(root, workDir, plan);
    notify({
        type: 'plan.ready',
        summary: plan.summary,
        stages: plan.steps.map((step) => step.stage),
        skipped: plan.skipped.map((item) => item.stage),
        path: planPath,
    });

    // A run that starts in the middle of the pipeline continues from the artifacts of the last
    // one: the stages before it are not repeated, they cost money and their answer is on disk.
    await resumeFromWorkDir(state, { stages: toRun.map((stage) => stage.id), notify });

    // A stage that stops the run — a submitted batch, for one — still closes what it opened.
    let failed = false;
    try {
        failed = await runStages(toRun, state, notify);
    } finally {
        for (const connection of mcp) await connection.close().catch(() => {});
    }

    // The contract of the project: what this run made and where it lies. The other systems
    // of the house read it to find the work of this one.
    try {
        await publishDelivery(root, config, state);
    } catch (cause) {
        state.warnings.push(`The contract of the project was not written: ${cause?.message ?? cause}`);
    }

    return { output: state.decomposition, outputPath: state.outputPath ?? null, warnings: state.warnings, failed };
}

/**
 * Run the stages one after another.
 *
 * A stage that throws does not stop the pipeline: the run goes on, the failure is remembered as a
 * warning, and the caller is told that something did not work. Only an abort leaves the run.
 * @param {Array<{ id: string, label: string, run: Function }>} stages the stages to run, in order
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<boolean>} true when a stage failed
 * @ai.hint io
 */
export async function runStages(stages, state, notify = () => {}) {
    let failed = false;
    for (const stage of stages) {
        notify({ type: 'stage.start', stage: stage.id, label: stage.label });
        const before = state.warnings.length;
        try {
            await stage.run(state, notify);
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            // The batch was submitted and the answers are not here yet: the run stops and waits
            // for the second phase. It is not a failure of the stage.
            if (error?.code === BATCH_SUBMITTED) throw error;
            state.warnings.push(`${stage.id}: ${error.message}`);
            failed = true;
            notify({ type: 'stage.error', stage: stage.id, error: error.message });
        }
        // Every warning a stage collected is shown to the reader, not only kept in the state.
        for (const message of state.warnings.slice(before)) {
            notify({ type: 'warning', message });
        }
        // What the stage produced is written down: a run that starts in the middle of the
        // pipeline continues from it instead of paying for the stages before it again.
        await saveStageManifest(state, stage.id).catch(() => {});
        notify({ type: 'stage.done', stage: stage.id });
    }
    return failed;
}
