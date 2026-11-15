/**
 * @file src/shared/scratch.js
 * @module shared/scratch
 * @purpose The scratch of a run: the place where the stages keep what they try.
 *
 *   The scratch is the state of a run and not a part of the delivery: it lives in the house of
 *   the project — `.ai/tmp/<run-id>/` — and dies with the run. The delivery keeps the product
 *   alone: the screens, the repairs, the layers.
 *
 *   The pipeline gives the stages the directory of the scratch. A state that was made by hand
 *   gets the same path from the house: the path of the scratch is computed in one place.
 *
 * @depends shared/house
 * @usedBy stages/extension, stages/overlap, stages/reconstruct, stages/rectify, stages/rectify-ai
 * @exports scratchDir
 * @ai.tags scratch, house
 * @ai.hint pure
 */

import { runStateDir } from './house.js';

/**
 * The directory of the scratch of a run.
 * @param {object} state the state of the run
 * @returns {string} the absolute path of the directory
 * @exports
 * @ai.hint pure
 */
export function scratchDir(state) {
    const given = String(state?.scratchDir ?? '').trim();
    if (given) return given;
    const root = state?.root ?? process.cwd();
    return runStateDir(root, state?.runId ?? 'run', state?.config ?? {});
}
