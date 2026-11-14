/**
 * @file src/stages/rectify-ai.js
 * @module stages/rectify-ai
 * @purpose The `ai-mode` of the rectify stage: the AI straightens the reference as a whole, the
 *          geometry cuts the screens out of the straightened picture, and what is still broken is
 *          repaired in fragments.
 *
 *   The order is the point of the mode. The AI works on the picture first, because a picture that
 *   is not level cannot be cut well: the corners of a tilted screen are the corners of a tilted
 *   screen, and no projection can make them straight. The cut itself stays with the geometry —
 *   the role still names the four corners of every screen and the harness still projects the
 *   pixels, so the AI never decides where a screen begins. The repair comes last and touches
 *   only the fragments that are broken, so the pixels of the deterministic path survive wherever
 *   they are good enough.
 *
 *   Every step of the AI is judged by the measurement, not by the model: the straightened
 *   reference has to be flatter than the original, and a repair has to be better than the picture
 *   it replaces. What does not pass the gate is rolled back, and the original bytes stay.
 *
 * @depends node:path, node:fs/promises, stages/rectify, stages/repair, image/skew, openai/images
 * @usedBy stages/index
 * @exports runRectifyAi, straightenReference, STRAIGHTENED_DIR, STRAIGHTEN_PROMPT
 * @ai.tags rectification, ai-mode, perspective
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { toPosix } from '../agent/paths.js';
import { measureResidualSkew } from '../image/skew.js';
import { imageModelFor } from '../openai/images.js';
import { runRectify, referenceFiles, opaqueShare, swapReferencePaths } from './rectify.js';
import { editFragment } from './repair.js';

/** Subdirectory of the work dir that holds the straightened references. */
export const STRAIGHTENED_DIR = 'straightened';

/** What the editor is told when the whole reference has to be straightened. */
export const STRAIGHTEN_PROMPT = [
    'Straighten this picture as a whole. The screens in it are seen at an angle: rotate the picture',
    'so that the lines of text run horizontally and correct the perspective, so that the screens',
    'face the viewer. Keep the content exactly as it is: no screen is added, none is removed, no',
    'text is written or erased, and every screen keeps its place in the frame. The result is the',
    'same picture, only straightened.',
].join(' ');

/**
 * Straighten one reference with the image editor and keep the result only when it is flatter.
 *
 * The AI may be asked more than once, and every attempt starts from the original picture: an
 * attempt on top of an attempt stacks the error of the first one. The flattest accepted attempt
 * wins; when no attempt is flatter than the original, the original stays and the file of the
 * attempt is deleted.
 * @param {{ client: object, editorModel: string, file: { rel: string, abs: string }, root: string,
 *   outDir: string, engine?: string, attempts?: number, quality?: string|null,
 *   maxResidualDeg?: number }} params
 * @returns {Promise<{ accepted: boolean, rel: string, abs: string, before: number|null,
 *   after: number|null, reason: string }>}
 * @ai.hint io
 */
export async function straightenReference({
    client, editorModel, file, root, outDir, engine = 'auto', attempts = 1, quality = null,
    maxResidualDeg = 0.8,
}) {
    const source = await measureResidualSkew(file.abs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 })
        .catch(() => null);
    const sourceAngle = Math.abs(source?.angleDeg ?? 0);
    const keep = (reason) => ({
        accepted: false, rel: file.rel, abs: file.abs, before: source?.angleDeg ?? null, after: null, reason,
    });

    if (!source || (source.confidence ?? 0) < 0.15) {
        return keep('the tilt of the reference cannot be measured');
    }
    if (sourceAngle <= maxResidualDeg) {
        return keep(`the reference is already level (${sourceAngle.toFixed(1)}°)`);
    }
    const bytes = await readFile(file.abs).catch(() => null);
    if (!bytes) return keep('the file of the reference cannot be read');

    await mkdir(outDir, { recursive: true });
    const rounds = Number.isSafeInteger(attempts) ? Math.max(1, attempts) : 1;
    let best = null;
    let reason = 'the editor did not answer';
    for (let attempt = 1; attempt <= rounds; attempt++) {
        const edited = await editFragment({
            client,
            editorModel,
            prompt: STRAIGHTEN_PROMPT,
            filename: path.basename(file.abs),
            bytes,
            maxAttempts: 1,
            quality,
        });
        if (!edited) break;

        const candidateAbs = path.join(outDir, `${path.parse(file.rel).name}-${attempt}.png`);
        await writeFile(candidateAbs, edited);
        const filled = await opaqueShare(candidateAbs, engine);
        if (filled < 0.5) {
            await unlink(candidateAbs).catch(() => {});
            reason = 'the straightened picture carries no pixels';
            break;
        }
        const measured = await measureResidualSkew(candidateAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 })
            .catch(() => null);
        const angle = measured ? Math.abs(measured.angleDeg) : null;
        if (angle === null) {
            await unlink(candidateAbs).catch(() => {});
            reason = 'the tilt of the straightened picture cannot be measured';
            break;
        }
        if (!best || angle < best.angle) {
            if (best) await unlink(best.abs).catch(() => {});
            best = { abs: candidateAbs, angle, measured };
            reason = `straightened: ${sourceAngle.toFixed(1)}° → ${angle.toFixed(1)}°`;
        } else {
            await unlink(candidateAbs).catch(() => {});
        }
        // The picture is flat enough: another attempt would only cost more.
        if (best.angle <= maxResidualDeg) break;
    }

    if (!best) return keep(reason);
    // The gate of the mode: the result has to be flatter than the picture it replaces. A result
    // that is not flatter is not a repair — it is a redrawing of the reference with no gain.
    if (best.angle >= sourceAngle) {
        await unlink(best.abs).catch(() => {});
        return keep(`not flatter than the reference (${sourceAngle.toFixed(1)}° → ${best.angle.toFixed(1)}°)`);
    }
    return {
        accepted: true,
        rel: toPosix(path.relative(root, best.abs)),
        abs: best.abs,
        before: source.angleDeg,
        after: best.measured.angleDeg,
        reason,
    };
}

/**
 * Run the rectify stage in the `ai-mode`.
 *
 * The AI straightens the references first, the geometry cuts the screens out of the straightened
 * pictures, and the state of the run points at the screens that were cut. The repair of the
 * broken fragments and the cleanup of the overlap follow in the same stage.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function runRectifyAi(state, notify = () => {}) {
    const { root, workDir, config, client, warnings } = state;
    const references = referenceFiles(state, root);
    if (!references.length) {
        warnings.push('rectify: no screens to rectify');
        return;
    }
    if (!client?.images) {
        warnings.push('rectify: images API unavailable, the ai-mode is skipped');
        return;
    }
    const editorModel = state.imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) {
        warnings.push('rectify: no image model for the editor, the ai-mode is skipped');
        return;
    }

    const settings = config.stages?.rectify ?? {};
    const engine = config.raster?.engine ?? 'auto';
    const attempts = Number.isSafeInteger(settings.straightenAttempts) ? Math.max(1, settings.straightenAttempts) : 1;
    const quality = settings.quality ?? null;
    const maxResidualDeg = Number.isFinite(settings.residualSkewLimitDeg) ? settings.residualSkewLimitDeg : 0.8;

    const outDir = path.join(root, workDir, STRAIGHTENED_DIR);
    await mkdir(outDir, { recursive: true });

    // The first half of the mode: the AI straightens every reference it is given.
    /** The reference rel of every straightened reference. */
    const straightened = new Map();
    /** The reference rel the straightened file came from. */
    const sourceOf = new Map();
    for (const reference of references) {
        const result = await straightenReference({
            client, editorModel, file: reference, root, outDir, engine, attempts, quality, maxResidualDeg,
        });
        if (result.accepted) {
            straightened.set(reference.rel, result.rel);
            sourceOf.set(result.rel, reference.rel);
        }
        notify({
            type: 'rectify.straightened',
            file: result.accepted ? result.rel : reference.rel,
            from: reference.rel,
            before: result.before,
            after: result.after,
            accepted: result.accepted,
            reason: result.reason,
        });
    }

    // The second half: the geometry cuts the straightened reference. The stage sees the
    // straightened file as the reference of the run, and the crops of the decompose stage point at
    // it, so the roles and the projection work exactly as they do in the `geometry` mode.
    const effective = references.map((reference) => ({
        ...reference,
        rel: straightened.get(reference.rel) ?? reference.rel,
    }));
    const aiState = {
        ...state,
        rectified: [],
        references: effective.map((reference) => reference.rel),
        screensFiles: Array.isArray(state.screensFiles)
            ? state.screensFiles.map((file) => ({ ...file, source: remapSource(file, straightened) }))
            : state.screensFiles,
    };
    const images = state.images ? [...state.images] : [];
    await runRectify(aiState, notify);

    state.rectified.push(...aiState.rectified);
    state.screens = aiState.screens;
    if (aiState.screensFiles) state.screensFiles = aiState.screensFiles;
    // The reference of the run points at the screens it was cut into — under the name of the
    // original reference, so the next stage finds the same picture it would have found.
    const alias = [];
    for (const item of aiState.rectified) {
        alias.push(item);
        const original = sourceOf.get(item.from);
        if (original) alias.push({ ...item, from: original });
    }
    state.images = swapReferencePaths(images, alias).paths;
}

/**
 * The source of a screen file, pointed at the straightened reference when there is one.
 * @param {{ source?: string }} file the screen file
 * @param {Map<string, string>} straightened the reference rel → the straightened rel
 * @returns {string}
 * @ai.hint pure
 */
function remapSource(file, straightened) {
    const source = toPosix(String(file?.source ?? '').trim());
    if (!source) return source;
    for (const [from, to] of straightened) {
        if (source === from || source.endsWith(`/${from}`) || from.endsWith(`/${source}`)) return to;
    }
    return source;
}
