/**
 * @file src/stages/index.js
 * @module stages
 * @purpose The registry of the pipeline stages: their labels, what each of them is for, the role
 *          each of them asks and the directory their artifacts land in.
 * @depends stages/extension, stages/decompose, stages/rectify, stages/reconstruct, stages/overlap,
 *   stages/resolve
 * @usedBy shared/pipeline
 * @exports STAGE_DEFS, STAGE_IDS, STAGE_ROLES, STAGE_DIRS, stageById, rectifyMode
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
import { imageModelFor } from '../openai/images.js';

/**
 * The rectify stage in the mode the config asks for.
 *
 * The mode is decided by the plan of the run: the reception names `geometry` or `ai-mode`, and
 * the config is the fallback for the runs that were not planned. The `auto` mode — the default —
 * asks the picture model for the straightening when there is one, and falls back to the geometry
 * when there is none: the work of the stage is not lost because the host of the picture model is
 * down.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 */
const runRectifyStage = (state, notify) => (
    rectifyMode(state) === 'ai-mode'
        ? runRectifyAi(state, notify)
        : runRectify(state, notify)
);

/**
 * The mode of the rectify stage of this run.
 *
 * `geometry` — the role places the corners and the harness projects the pixels.
 * `ai-mode` — the AI straightens the whole reference first and keeps the geometry behind it.
 * `auto` — the AI mode when the picture model is there, the geometry when it is not.
 * @param {object} state pipeline state
 * @returns {'geometry'|'ai-mode'}
 * @exports
 * @ai.hint pure
 */
export function rectifyMode(state) {
    const mode = state?.config?.stages?.rectify?.mode ?? 'auto';
    if (mode === 'ai-mode' || mode === 'geometry') return mode;
    const editor = state?.imageModel || imageModelFor(state?.config, { hasImage: true });
    return (state?.client?.images && editor) ? 'ai-mode' : 'geometry';
}

/**
 * The overlap stage, unless the ai-mode of the rectify stage has cleaned it already.
 *
 * The mode cleans the overlap inside the rectify stage, so the work is done once: the separate
 * stage notices it and does not pay for the same cleaning a second time.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 */
const runOverlapStage = async (state, notify) => {
    if (state.overlapCleanedInAiMode) {
        notify({
            type: 'overlap.skipped',
            reason: 'the ai-mode of the rectify stage has cleaned the overlap already',
        });
        return;
    }
    await runOverlap(state, notify);
};

/**
 * The stages of the pipeline. The order here is the usual one — the order the plan of a run
 * starts from. The plan of the run may leave a stage out, put the stages in another order and
 * change the parameters of a stage; the order here is only the fallback.
 * @type {ReadonlyArray<{ id: string, label: string, about: string, role: string, run: Function, dir: string }>}
 */
export const STAGE_DEFS = Object.freeze([
    {
        id: 'extend',
        label: 'Extend reference',
        about: 'Grow the frame of the picture when the content is cut through real content. '
            + 'The band is painted by the picture model. It is the stage for a picture that ends '
            + 'in the middle of a screen.',
        role: 'extender',
        run: runExtension,
        dir: EXTENDED_DIR,
    },
    {
        id: 'decompose',
        label: 'Crop to screens',
        about: 'Split the reference into the screens it shows, one clean sub-reference per screen. '
            + 'It is the stage every run needs: the other stages work on the screens it cuts.',
        role: 'decomposer',
        run: runDecompose,
        dir: 'screens',
    },
    {
        id: 'rectify',
        label: 'Rectify screens',
        about: 'Straighten the screens: un-rotate them, recover the projection of a photographed '
            + 'screen, cut the screens out of a collage. The geometry mode places the corners and '
            + 'projects the pixels; the ai-mode lets the picture model straighten the reference '
            + 'first, repairs the broken parts by fragments and cleans the content of the '
            + 'neighbouring screens.',
        role: 'rectifier',
        run: runRectifyStage,
        dir: RECTIFIED_DIR,
    },
    {
        id: 'reconstruct',
        label: 'Restore lost details',
        about: 'Restore what the cut lost: a strip of a neighbour, a bezel, a seam, the rounded '
            + 'corners of the display. The role names the broken regions and the geometry, the '
            + 'harness cuts the boxes and stitches the answers back.',
        role: 'restorer',
        run: runReconstruct,
        dir: RESTORED_DIR,
    },
    {
        id: 'overlap',
        label: 'Remove overlaps',
        about: 'Remove the content of the neighbouring screens that came along with the cut. '
            + 'The stage is skipped when the ai-mode of the rectify stage has cleaned it already.',
        role: 'overlap',
        run: runOverlapStage,
        dir: OVERLAP_DIR,
    },
    {
        id: 'resolve',
        label: 'Resolve final output',
        about: 'Write the answer: decomposition.json with the screens, their files and their '
            + 'measurements. The layers of a screen are written here too, and only when somebody '
            + 'asked for them.',
        role: 'director',
        run: runResolve,
        dir: DECOMPOSITION_FILE,
    },
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
