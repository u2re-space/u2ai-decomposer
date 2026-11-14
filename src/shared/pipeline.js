/**
 * @file src/shared/pipeline.js
 * @module shared/pipeline
 * @purpose Pipeline orchestrator: runs stages in order, passes artifacts between them.
 * @depends node:path, node:fs/promises, shared/manifest, shared/resume
 * @exports STAGES, runPipeline
 * @ai.tags pipeline, stages
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRoleRunner } from '../roles/index.js';
import { createToolset } from '../agent/tools.js';
import { loadSkills } from '../agent/skills.js';
import { connectMcpServers } from '../agent/mcp.js';
import { STAGE_DEFS, STAGE_DIRS, STAGE_ROLES } from '../stages/index.js';
import { DECOMPOSITION_FILE } from '../stages/resolve.js';
import { saveStageManifest } from './manifest.js';
import { resumeFromWorkDir } from './resume.js';

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
 * Execute the pipeline stages in order.
 * @param {{
 *   root: string, images: string[], outDir: string, stages: string[],
 *   config: object, client: object, model?: string|null, effort?: string|null,
 *   imageModel?: string|null, advanced?: boolean, stopAfter?: string|null,
 *   dryRun?: boolean, notify?: (event: object) => void
 * }} opts
 * @returns {Promise<{ output: object, warnings: string[] }>}
 */
export async function runPipeline({
    root, images, outDir = '.', stages: requestedStages,
    config, client, model = null, effort = null, imageModel = null,
    advanced = false, stopAfter = null, dryRun = false, notify = () => {},
}) {
    const skills = {};
    for (const role of ['extender', 'decomposer', 'rectifier', 'restorer', 'overlap', 'director']) {
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

    // Filter stages to run.
    const selected = requestedStages ?? STAGES.map((stage) => stage.id);
    const toRun = STAGES.filter((stage) => (
        selected.includes(stage.id)
        && config?.stages?.[stage.id]?.enabled !== false
    ));
    if (stopAfter) {
        const stopIdx = toRun.findIndex((s) => s.id === stopAfter);
        if (stopIdx >= 0) toRun.length = stopIdx + 1;
    }

    if (dryRun) {
        const outputs = toRun.map((stage) => (
            stage.id === 'resolve'
                ? path.join(outDir, DECOMPOSITION_FILE)
                : path.join(workDir, STAGE_DIRS[stage.id] ?? stage.id)
        ));
        notify({
            type: 'plan',
            images,
            stages: toRun.map((stage) => {
                const role = roles.resolve(STAGE_ROLES[stage.id]);
                return {
                    id: stage.id,
                    label: stage.label,
                    model: role.model,
                    imageModel: role.imageModel ?? imageModel ?? config?.imageModel ?? null,
                };
            }),
            outputs,
        });
        return { output: null, warnings: [], failed: false };
    }

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
        config,
        client,
        roles,
        model,
        effort,
        imageModel,
        advanced,
        dryRun,
        extended: [],
        canvas: [],
        screens: [],
        screensFiles: [],
        toolset,
        rectified: [],
        restored: [],
        overlapResolved: [],
        decomposition: null,
        warnings: [],
    };

    // A run that starts in the middle of the pipeline continues from the artifacts of the last
    // one: the stages before it are not repeated, they cost money and their answer is on disk.
    await resumeFromWorkDir(state, { stages: toRun.map((stage) => stage.id), notify });

    const failed = await runStages(toRun, state, notify);

    for (const connection of mcp) await connection.close().catch(() => {});

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