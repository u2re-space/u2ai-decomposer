/**
 * @file src/stages/extension.js
 * @module stages/extension
 * @purpose Stage 0: grow a reference frame that ends inside real content.
 * @depends node:path, node:fs/promises, image/raster, openai/images, openai/responses, agent/schemas
 * @exports runExtension, extensionTarget, regionDelta, seamDelta, bandFillShare, extenderPrompt, EXTENDER_FRAME
 * @ai.tags extension, outpainting, decomposition, images
 * @ai.hint legacy-0.2
 */
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
    decodeRgba,
    encodeRgba,
    rasterCrop,
    rasterPadImageBytes,
    rasterPatch,
} from '../image/raster.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';
import { EXTEND_SCHEMA } from '../agent/schemas.js';

const EXTENDED_DIR = 'extended';
const GROWABLE_EDGES = new Set(['bottom', 'right', '']);
const MIN_PROMPT_LENGTH = 24;
const MIN_BAND_FILL = 0.5;

/**
 * The contract appended to the instruction written by the `extender` role.
 *
 * The role says what continues into the band. This says that the band is the only part the editor
 * may touch, so the source pixels stay measurable at their original scale.
 */
export const EXTENDER_FRAME = 'The attached picture is a reference image whose canvas has been made larger. '
    + 'Its original content occupies the top-left part of the frame and is already finished; the rest of the frame is empty. '
    + 'Draw only into the empty part, continuing what the edge of the original content leaves open. '
    + 'Do not move, resize, crop, rescale, sharpen, recolour or redraw anything inside the original content, '
    + 'and do not add a frame, a border or a watermark. '
    + 'Return the same frame size you were given, with the original content in exactly the same place.';

/**
 * The full text sent to the image editor.
 * @param {string} authored wording written by the extender role
 * @returns {string}
 */
export function extenderPrompt(authored) {
    return `${String(authored ?? '').trim()}\n\n${EXTENDER_FRAME}`;
}

/**
 * The canvas to ask the editor for.
 *
 * The band is a share of the long edge. The original picture stays in the top-left corner and is
 * never resampled; the editor receives transparent pixels to the right or below it.
 * @param {{ width: number, height: number }} size
 * @param {number} padFraction
 * @param {string} edge
 * @returns {{ width: number, height: number, band: number }|null}
 */
export function extensionTarget(size, padFraction = 0.25, edge = 'bottom') {
    const width = Number(size?.width);
    const height = Number(size?.height);
    const fraction = Number(padFraction);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    if (!Number.isFinite(fraction) || fraction <= 0) return null;
    const band = Math.max(1, Math.round(Math.max(width, height) * fraction));
    if (edge === 'right') return { width: width + band, height, band };
    if (edge === 'bottom' || edge === '') return { width, height: height + band, band };
    return null;
}

/**
 * How far the original area of an answer drifted from the source.
 * @param {{ width: number, data: Buffer }} before
 * @param {{ width: number, data: Buffer }} after
 * @param {number} width
 * @param {number} height
 * @returns {{ meanDelta: number, changedShare: number }}
 */
export function regionDelta(before, after, width, height) {
    let sum = 0;
    let changed = 0;
    let seen = 0;
    for (let y = 0; y < height; y++) {
        const beforeRow = y * before.width * 4;
        const afterRow = y * after.width * 4;
        for (let x = 0; x < width; x++) {
            const from = beforeRow + x * 4;
            const to = afterRow + x * 4;
            const delta = Math.abs(before.data[from] - after.data[to])
                + Math.abs(before.data[from + 1] - after.data[to + 1])
                + Math.abs(before.data[from + 2] - after.data[to + 2]);
            sum += delta / 3;
            if (delta > 12) changed += 1;
            seen += 1;
        }
    }
    return { meanDelta: seen ? sum / seen : Infinity, changedShare: seen ? changed / seen : 1 };
}

/**
 * Measure the seam between the source and the answer.
 *
 * A generative editor repaints some of the source, so an exact byte comparison would reject every
 * honest outpaint. The seam is the strip at the clipped edge: if it stayed in place, the answer
 * kept the source at 1:1 scale and only painted the new band. The returned `delta` combines the
 * normalized colour drift and the share of changed seam pixels, so one threshold can govern it.
 * @param {{ width: number, data: Buffer }} before
 * @param {{ width: number, data: Buffer }} after
 * @param {number} width original width
 * @param {number} height original height
 * @param {{ edge?: string, fraction?: number }} [options]
 * @returns {{ delta: number, meanDelta: number, changedShare: number, size: number }}
 */
export function seamDelta(before, after, width, height, { edge = 'bottom', fraction = 0.06 } = {}) {
    const size = Math.max(1, Math.round((edge === 'right' ? width : height) * Math.max(0, fraction)));
    let sum = 0;
    let changed = 0;
    let seen = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (edge !== 'right' && y < height - size) continue;
            if (edge === 'right' && x < width - size) continue;
            const from = (y * before.width + x) * 4;
            const to = (y * after.width + x) * 4;
            const delta = Math.abs(before.data[from] - after.data[to])
                + Math.abs(before.data[from + 1] - after.data[to + 1])
                + Math.abs(before.data[from + 2] - after.data[to + 2]);
            sum += delta / 3;
            if (delta > 12) changed += 1;
            seen += 1;
        }
    }
    const meanDelta = seen ? sum / seen : Infinity;
    const changedShare = seen ? changed / seen : 1;
    return { delta: meanDelta / 255 + changedShare, meanDelta, changedShare, size };
}

/**
 * Share of the new band that carries pixels rather than transparent padding.
 * @param {{ width: number, height: number, data: Buffer }} after
 * @param {number} width original width
 * @param {number} height original height
 * @param {string} edge
 * @returns {number}
 */
export function bandFillShare(after, width, height, edge = 'bottom') {
    let filled = 0;
    let seen = 0;
    for (let y = 0; y < after.height; y++) {
        for (let x = 0; x < after.width; x++) {
            if (edge === 'right') {
                if (x < width || y >= height) continue;
            } else if (y < height || x >= width) continue;
            if (after.data[(y * after.width + x) * 4 + 3] > 8) filled += 1;
            seen += 1;
        }
    }
    return seen ? filled / seen : 0;
}

/**
 * Fade the overlap at the source edge so the band does not meet it with a hard line.
 * @param {Buffer} bytes
 * @param {string} edge
 * @param {number} overlap
 * @param {string} engine
 * @returns {Promise<Buffer>}
 */
async function featherOverlap(bytes, edge, overlap, engine) {
    const frame = await decodeRgba(bytes, engine);
    const span = Math.max(1, Math.min(overlap, edge === 'right' ? frame.width : frame.height));
    if (edge === 'right') {
        for (let x = 0; x < span; x++) {
            const weight = span <= 1 ? 1 : x / (span - 1);
            for (let y = 0; y < frame.height; y++) {
                const at = (y * frame.width + x) * 4;
                frame.data[at + 3] = Math.round(frame.data[at + 3] * weight);
            }
        }
    } else {
        for (let y = 0; y < span; y++) {
            const weight = span <= 1 ? 1 : y / (span - 1);
            for (let x = 0; x < frame.width; x++) {
                const at = (y * frame.width + x) * 4;
                frame.data[at + 3] = Math.round(frame.data[at + 3] * weight);
            }
        }
    }
    return await encodeRgba(frame, engine);
}

/**
 * Run the extension stage.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 */
export async function runExtension(state, notify = () => {}) {
    const { root, images, workDir, config, client, roles, model, effort, imageModel, warnings } = state;
    if (!images?.length) {
        warnings.push('extension: no images to process');
        return;
    }
    if (!client?.images) {
        warnings.push('extension: images API unavailable, skipping');
        return;
    }
    const extenderRole = roles.resolve?.('extender');
    const editorModel = imageModel || extenderRole?.imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) {
        warnings.push('extension: no image model configured, skipping');
        return;
    }

    const settings = config.stages?.extend ?? {};
    const padFraction = Number(settings.padFraction ?? 0.25);
    const maxAttempts = Number.isSafeInteger(settings.maxAttempts) ? settings.maxAttempts : 2;
    const seamLimit = Number(config.image?.seamDeltaMin ?? 0.25);
    const seamFraction = Number(config.image?.seamBandFraction ?? 0.06);
    const engine = config.raster?.engine ?? 'auto';
    if (padFraction <= 0 || maxAttempts <= 0) {
        warnings.push('extension: disabled by padFraction or maxAttempts');
        for (const img of images) state.extended.push({ from: img, to: img, kept: true });
        return;
    }

    const workRoot = path.resolve(root, workDir);
    const extDir = path.join(workRoot, EXTENDED_DIR);
    const scratchDir = path.join(workRoot, '.tmp', 'extend');
    await mkdir(extDir, { recursive: true });
    await mkdir(scratchDir, { recursive: true });

    for (const [index, img] of images.entries()) {
        const absolute = path.resolve(root, img);
        let bytes;
        try {
            bytes = await readFile(absolute);
        } catch {
            warnings.push(`extension: cannot read ${img}`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const before = await decodeRgba(bytes, engine);
        const answer = await roles.run('extender', {
            text: `Reference: ${img}\nSize: ${before.width}×${before.height} pixels.\n`
                + 'Say whether the frame cuts real content, and write the instruction for the band that would have to be grown.',
            parts: [imagePart(bytes, sniffImage(bytes).mime)],
            schema: EXTEND_SCHEMA,
            schemaName: 'extendPlan',
            maxTurns: 1,
            model,
            effort,
        });
        if (!answer?.data) {
            warnings.push(`extension: extender returned no plan for ${img}`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }
        if (answer.data.verdict !== 'extend') {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const edge = String(answer.data.edge ?? '').trim().toLowerCase();
        const prompt = String(answer.data.prompt ?? '').trim();
        if (!GROWABLE_EDGES.has(edge) || prompt.length < MIN_PROMPT_LENGTH) {
            warnings.push(`extension: unusable extension plan for ${img}`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const target = extensionTarget(before, padFraction, edge);
        if (!target) {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }
        const padded = await rasterPadImageBytes({
            bytes,
            engine,
            targetWidth: target.width,
            targetHeight: target.height,
        });
        if (!padded?.padded) {
            warnings.push(`extension: local canvas did not grow for ${img}`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        let accepted = null;
        let lastReason = 'no answer';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            notify({ type: 'extend.attempt', file: img, attempt, maxAttempts, model: editorModel });
            let edited;
            try {
                edited = await client.images.edit({
                    model: editorModel,
                    prompt: extenderPrompt(prompt),
                    size: `${padded.width}x${padded.height}`,
                    format: config.image?.format ?? 'png',
                    quality: config.image?.quality ?? null,
                    background: config.image?.background ?? 'auto',
                    image: {
                        filename: path.basename(img),
                        mime: sniffImage(padded.bytes).mime,
                        bytes: padded.bytes,
                    },
                });
            } catch (error) {
                lastReason = error?.message ?? String(error);
                continue;
            }
            const answerBytes = edited?.images?.[0]?.bytes;
            if (!answerBytes) {
                lastReason = 'the image editor returned an empty answer';
                continue;
            }

            let after;
            try {
                after = await decodeRgba(answerBytes, engine);
            } catch (error) {
                lastReason = error?.message ?? String(error);
                continue;
            }
            if (after.width < padded.width || after.height < padded.height) {
                lastReason = `the image editor returned ${after.width}×${after.height} instead of ${padded.width}×${padded.height}`;
                continue;
            }

            const seam = seamDelta(before, after, before.width, before.height, { edge, fraction: seamFraction });
            const fill = bandFillShare(after, before.width, before.height, edge);
            if (seam.delta > seamLimit) {
                lastReason = `seam drifted by ${seam.delta.toFixed(3)} (limit ${seamLimit})`;
                continue;
            }
            if (fill < MIN_BAND_FILL) {
                lastReason = `the new band is only ${Math.round(fill * 100)}% filled`;
                continue;
            }
            accepted = { bytes: answerBytes, after, seam, fill };
            break;
        }

        if (!accepted) {
            warnings.push(`extension: ${img} rejected (${lastReason})`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const stem = path.basename(img, path.extname(img));
        const paddedAbs = path.join(scratchDir, `${index}-${stem}-padded.png`);
        const answerAbs = path.join(scratchDir, `${index}-${stem}-answer.png`);
        const patchAbs = path.join(scratchDir, `${index}-${stem}-patch.png`);
        const featheredAbs = path.join(scratchDir, `${index}-${stem}-feathered.png`);
        const mergedAbs = path.join(scratchDir, `${index}-${stem}-merged.png`);
        const outputAbs = path.join(extDir, path.basename(img));
        try {
            await writeFile(paddedAbs, padded.bytes);
            await writeFile(answerAbs, accepted.bytes);

            const overlap = Math.max(1, Math.min(
                edge === 'right' ? before.width : before.height,
                Math.round((edge === 'right' ? before.width : before.height) * seamFraction),
            ));
            const x = edge === 'right' ? before.width - overlap : 0;
            const y = edge === 'right' ? 0 : before.height - overlap;
            const patchWidth = padded.width - x;
            const patchHeight = padded.height - y;
            await rasterCrop({
                input: answerAbs,
                output: patchAbs,
                x,
                y,
                width: patchWidth,
                height: patchHeight,
                cwd: root,
                engine,
            });
            const feathered = await featherOverlap(
                await readFile(patchAbs),
                edge,
                edge === 'right' ? Math.min(overlap, patchWidth) : Math.min(overlap, patchHeight),
                engine,
            );
            await writeFile(featheredAbs, feathered);
            await rasterPatch({
                input: paddedAbs,
                patch: featheredAbs,
                output: mergedAbs,
                x,
                y,
                width: patchWidth,
                height: patchHeight,
                cwd: root,
                engine,
                blend: true,
            });
            await writeFile(outputAbs, await readFile(mergedAbs));

            const relativeOutput = path.relative(root, outputAbs) || path.basename(outputAbs);
            state.extended.push({
                from: img,
                to: relativeOutput,
                kept: false,
                edge: edge || 'bottom',
                band: { width: padded.width - before.width, height: padded.height - before.height },
                seamDelta: Number(accepted.seam.delta.toFixed(4)),
                fill: Number(accepted.fill.toFixed(4)),
            });
            state.canvas.push({
                from: img,
                to: relativeOutput,
                width: padded.width,
                height: padded.height,
                edge: edge || 'bottom',
            });
            notify({ type: 'extend.done', file: img, to: relativeOutput, seamDelta: accepted.seam.delta });
        } catch (error) {
            warnings.push(`extension: ${img} could not be stitched (${error?.message ?? error})`);
            state.extended.push({ from: img, to: img, kept: true });
        }
    }

    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    state.images = state.extended.map((entry) => entry.to);
}
