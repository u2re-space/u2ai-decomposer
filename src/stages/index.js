/**
 * @file src/stages/index.js
 * @module stages
 * @purpose The registry of the pipeline stages: their order, their labels, the role each of them
 *          asks and the directory their artifacts land in.
 * @depends stages/extension, stages/decompose, stages/rectify, stages/reconstruct, stages/overlap,
 *   stages/resolve
 * @usedBy shared/pipeline
 * @exports STAGE_DEFS, STAGE_IDS, STAGE_ROLES, STAGE_DIRS, stageById
 * @ai.tags pipeline, stages
 * @ai.hint keep
 */

import { runExtension, EXTENDED_DIR } from './extension.js';
import { runDecompose } from './decompose.js';
import { runRectify, RECTIFIED_DIR } from './rectify.js';
import { runRectifyAi } from './rectify-ai.js';
import { runReconstruct, RESTORED_DIR } from './reconstruct.js';
import { runOverlap, OVERLAP_DIR } from './overlap.js';
import { runResolve, DECOMPOSITION_FILE, LAYERS_DIR } from './resolve.js';

/**
 * The rectify stage in the mode the config asks for.
 *
 * The default mode is the geometry one: the role names the corners and the harness projects the
 * pixels. The `ai-mode` puts the AI in front of the whole reference first and keeps the geometry
 * behind it.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 */
const runRectifyStage = (state, notify) => (
    state.config?.stages?.rectify?.mode === 'ai-mode'
        ? runRectifyAi(state, notify)
        : runRectify(state, notify)
);

/**
 * The six stages of the pipeline, in the order they run. The order is fixed: a stage may only
 * read what the earlier stages wrote.
 * @type {ReadonlyArray<{ id: string, label: string, role: string, run: Function, dir: string }>}
 */
export const STAGE_DEFS = Object.freeze([
    { id: 'extend', label: 'Extend reference', role: 'extender', run: runExtension, dir: EXTENDED_DIR },
    { id: 'decompose', label: 'Crop to screens', role: 'decomposer', run: runDecompose, dir: 'screens' },
    { id: 'rectify', label: 'Rectify screens', role: 'rectifier', run: runRectifyStage, dir: RECTIFIED_DIR },
    { id: 'reconstruct', label: 'Restore lost details', role: 'restorer', run: runReconstruct, dir: RESTORED_DIR },
    { id: 'overlap', label: 'Remove overlaps', role: 'overlap', run: runOverlap, dir: OVERLAP_DIR },
    { id: 'resolve', label: 'Resolve final output', role: 'director', run: runResolve, dir: DECOMPOSITION_FILE },
]);

/** The ids of the stages, in order. */
export const STAGE_IDS = Object.freeze(STAGE_DEFS.map((stage) => stage.id));

/** The role each stage asks for its plan or its verdict. */
export const STAGE_ROLES = Object.freeze(Object.fromEntries(STAGE_DEFS.map((stage) => [stage.id, stage.role])));

/** The directory each stage writes its artifacts into, relative to the work directory. */
export const STAGE_DIRS = Object.freeze(Object.fromEntries(STAGE_DEFS.map((stage) => [stage.id, stage.dir])));

/**
 * The stage with this id.
 * @param {string} id
 * @returns {object|null}
 * @ai.hint pure
 */
export function stageById(id) {
    return STAGE_DEFS.find((stage) => stage.id === id) ?? null;
}

export { LAYERS_DIR };
