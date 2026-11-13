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
    const roles = createRoleRunner({ client });
    const workDir = path.join(outDir, 'decomposition');
    await mkdir(workDir, { recursive: true });

    // Filter stages to run.
    const toRun = STAGES.filter((s) => requestedStages.includes(s.id));
    if (stopAfter) {
        const stopIdx = toRun.findIndex((s) => s.id === stopAfter);
        if (stopIdx >= 0) toRun.length = stopIdx + 1;
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
        screens: [],
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

    return { output: state.decomposition, warnings: state.warnings };
}