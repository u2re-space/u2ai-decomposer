/**
 * @file src/shared/pipeline.js
 * @module shared/pipeline
 * @purpose Pipeline orchestrator: runs stages in order, passes artifacts between them.
 * @depends node:path, node:fs/promises
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
import { runExtension } from '../stages/extension.js';
import { runDecompose } from '../stages/decompose.js';
import { runRectify } from '../stages/rectify.js';
import { runReconstruct } from '../stages/reconstruct.js';
import { runOverlap } from '../stages/overlap.js';
import { runResolve } from '../stages/resolve.js';

/**
 * Ordered stage definitions.
 * @type {Array<{ id: string, label: string, run: Function }>}
 */
export const STAGES = [
    { id: 'extend',      label: 'Extend reference',      run: runExtension },
    { id: 'decompose',   label: 'Crop to screens',       run: runDecompose },
    { id: 'rectify',     label: 'Rectify screens',       run: runRectify },
    { id: 'reconstruct', label: 'Restore lost details',  run: runReconstruct },
    { id: 'overlap',     label: 'Remove overlaps',       run: runOverlap },
    { id: 'resolve',     label: 'Resolve final output',  run: runResolve },
];

/** The role each stage asks for its plan or its verdict. */
const STAGE_ROLES = Object.freeze({
    extend: 'extender',
    decompose: 'decomposer',
    rectify: 'rectifier',
    reconstruct: 'restorer',
    overlap: 'overlap',
    resolve: 'director',
});

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
        const outputDirs = {
            extend: 'extended',
            decompose: 'screens',
            rectify: 'rectified',
            reconstruct: 'restored',
            overlap: 'overlap',
        };
        const outputs = toRun.map((stage) => (
            stage.id === 'resolve'
                ? path.join(outDir, 'decomposition.json')
                : path.join(workDir, outputDirs[stage.id] ?? stage.id)
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
        return { output: null, warnings: [] };
    }

    // Shared state passed between stages.
    const state = {
        root,
        images,
        workDir,
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

    for (const stage of toRun) {
        notify({ type: 'stage.start', stage: stage.id, label: stage.label });
        if (!dryRun) {
            try {
                await stage.run(state, notify);
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                state.warnings.push(`${stage.id}: ${error.message}`);
                notify({ type: 'stage.error', stage: stage.id, error: error.message });
            }
        }
        notify({ type: 'stage.done', stage: stage.id });
    }

    for (const connection of mcp) await connection.close().catch(() => {});

    return { output: state.decomposition, warnings: state.warnings };
}