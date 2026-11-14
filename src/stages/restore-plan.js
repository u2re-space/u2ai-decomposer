/**
 * @file src/stages/restore-plan.js
 * @module stages/restore-plan
 * @purpose The pure half of the reconstruct stage: turn the `restorer` role's answer into boxes that
 *          can safely be cut, and hold the contract every fragment travels under.
 * @depends agent/schemas
 * @usedBy stages/reconstruct
 * @exports EDITOR_FRAME, MAX_PATCH_COVERAGE, MIN_FRAGMENT_SIDE, FRAGMENT_MARGIN, planFragment,
 *   pickPatches, editorPrompt
 * @ai.tags restoration, validation, fragments
 * @ai.hint keep
 * @ai.hint legacy-0.2
 *
 * Split out of the stage because the judgement "this box is not a targeted repair" decides whether
 * a generative call can damage a reference, and it has to be testable without an image API.
 */

import { RESTORE_DEFECT_KINDS } from '../agent/schemas.js';

/**
 * The contract appended to every prompt the `restorer` role writes.
 *
 * It is the same for every region on purpose, and it is not a repair instruction: the role decides
 * what to fix and how, in words it wrote after looking at this picture. What the harness must never
 * lose is the fact that the attached file is a cut-out of a larger layout, that its scale and
 * content are not up for revision, and that the answer goes back into one fixed box. Without this
 * line an editor handed a 90×600 strip answers with a redesigned panel.
 */
export const EDITOR_FRAME = 'The attached file is a rectangular fragment cut out of a larger interface screenshot, not a screen of its own. '
    + 'Return a fragment of the same size, at the same scale and with the same content, in which only the named thing is changed. '
    + 'Keep every other pixel where it is: the same glyphs and letterforms, the same positions and sizes, the same colours, the same background. '
    + 'Do not recompose, do not re-center, do not crop, do not add a frame, a border, a shadow, a watermark or text of any kind. '
    + 'Where content continues into the region, continue it with the same style the surrounding pixels already show.';

/** A region larger than this share of the frame is a redraw of the screen, not a targeted repair. */
export const MAX_PATCH_COVERAGE = 0.45;

/**
 * Below this side an editor stops seeing the fragment as content and returns an invented tile, so
 * `planFragment` grows the box outwards instead of sending a sliver.
 */
export const MIN_FRAGMENT_SIDE = 64;

/** Context the editor needs around the damage: enough to continue a background into the region. */
export const FRAGMENT_MARGIN = 24;

/**
 * The fragment actually sent to the editor for one patch: the reported box plus a margin, clamped to
 * the frame and grown to the minimum side. `x`/`y`/`width`/`height` are both the crop box and the
 * stitch-back box, which is what makes the repair land exactly where the damage was.
 * @param {{ x: number, y: number, width: number, height: number }} patch
 * @param {{ frameWidth: number, frameHeight: number, margin?: number, minSide?: number }} options
 * @returns {{ x: number, y: number, width: number, height: number, grown: boolean }}
 * @ai.hint pure
 */
export function planFragment(patch, { frameWidth, frameHeight, margin = FRAGMENT_MARGIN, minSide = MIN_FRAGMENT_SIDE }) {
    const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), max));
    let x = clamp(patch.x - margin, frameWidth - 1);
    let y = clamp(patch.y - margin, frameHeight - 1);
    let width = Math.min(Math.round(patch.width + margin * 2), frameWidth - x);
    let height = Math.min(Math.round(patch.height + margin * 2), frameHeight - y);
    const grown = width < minSide || height < minSide;
    // Grow outwards first, and only towards the far edge once the near one has been paid back.
    if (width < minSide) {
        const extra = minSide - width;
        const takeLeft = Math.min(x, Math.ceil(extra / 2));
        x -= takeLeft;
        width = Math.min(minSide, frameWidth - x);
    }
    if (height < minSide) {
        const extra = minSide - height;
        const takeTop = Math.min(y, Math.ceil(extra / 2));
        y -= takeTop;
        height = Math.min(minSide, frameHeight - y);
    }
    return { x, y, width: Math.max(1, width), height: Math.max(1, height), grown };
}

/**
 * The patches worth sending, and the reasons for the rest.
 *
 * Three things make a patch unusable: it is not this kind of damage, it does not describe a region
 * of this frame, or it is so large that "repair" means "redraw the screen". Overlaps are dropped
 * rather than merged: two boxes over the same pixels ask the editor the same question twice, and the
 * second answer silently overwrites the first. The same holds for the regions that were repaired in
 * an earlier pass: they are passed in as `taken` and are not repaired twice.
 * @param {object[]} patches the role's answer
 * @param {{ frameWidth: number, frameHeight: number, maxPatches?: number, kinds?: string[],
 *   taken?: Array<{ x: number, y: number, width: number, height: number }> }} options
 *   `kinds` is the list of defect kinds this caller accepts, `taken` the boxes already repaired.
 * @returns {{ patches: object[], rejected: Array<{ patch: object, reason: string }> }}
 * @ai.hint pure
 */
export function pickPatches(patches = [], {
    frameWidth, frameHeight, maxPatches = 3, kinds = RESTORE_DEFECT_KINDS, taken = [],
}) {
    const accepted = [];
    const rejected = [];
    const area = Math.max(1, frameWidth * frameHeight);
    for (const raw of patches) {
        const patch = {
            screen: String(raw?.screen ?? '').trim(),
            kind: String(raw?.kind ?? '').trim(),
            x: Number(raw?.x), y: Number(raw?.y),
            width: Number(raw?.width), height: Number(raw?.height),
            source: String(raw?.source ?? '').trim() || 'screen',
            finding: String(raw?.finding ?? '').trim(),
            prompt: String(raw?.prompt ?? '').trim(),
        };
        if (!kinds.includes(patch.kind)) {
            rejected.push({ patch, reason: `the kind of defect "${patch.kind || '(empty)'}" is not in the list` });
            continue;
        }
        if (![patch.x, patch.y, patch.width, patch.height].every(Number.isFinite)) {
            rejected.push({ patch, reason: 'the coordinates are not numbers' });
            continue;
        }
        if (patch.x < 0 || patch.y < 0 || patch.width < 1 || patch.height < 1
            || patch.x + patch.width > frameWidth || patch.y + patch.height > frameHeight) {
            rejected.push({ patch, reason: `the region leaves the frame ${frameWidth}×${frameHeight}` });
            continue;
        }
        if (patch.width * patch.height / area > MAX_PATCH_COVERAGE) {
            rejected.push({
                patch,
                reason: `the region covers ${Math.round(patch.width * patch.height / area * 100)}% of the frame — `
                    + 'that is a redraw of the whole screen, not a targeted repair',
            });
            continue;
        }
        if (patch.prompt.length < 24) {
            rejected.push({ patch, reason: 'the instruction for the editor is too short to describe a repair' });
            continue;
        }
        if (taken.some((done) => overlaps(done, patch))) {
            rejected.push({ patch, reason: 'it overlaps a region that was repaired already' });
            continue;
        }
        if (accepted.some((done) => overlaps(done, patch))) {
            rejected.push({ patch, reason: 'it overlaps a region that was already accepted' });
            continue;
        }
        if (accepted.length >= Math.max(1, maxPatches)) {
            rejected.push({ patch, reason: `at most ${maxPatches} region(s) are accepted` });
            continue;
        }
        accepted.push(patch);
    }
    return { patches: accepted, rejected };
}

/**
 * Do two reported boxes share pixels.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 * @ai.hint pure
 */
function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The full text sent to the image editor: the role's wording, then the contract.
 * @param {string} authored the prompt the `restorer` role wrote for this region
 * @returns {string}
 * @ai.hint pure
 */
export function editorPrompt(authored) {
    return `${String(authored ?? '').trim()}\n\n${EDITOR_FRAME}`;
}
