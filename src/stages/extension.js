/**
 * @file src/stages/extension.js
 * @module stages/extension
 * @purpose Stage 0: grow a reference frame that ends inside real content.
 * @depends node:path, node:fs/promises, image/raster, openai/images, openai/responses, agent/schemas
 * @exports runExtension, extensionTarget, regionDelta, seamDelta, bandFillShare, bandRects,
 *   bandInnerSide, bandPatchRect, edgeList, extenderPrompt, featherBand, GROWABLE_EDGES,
 *   EXTENDER_FRAME, EXTENDED_DIR
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

/** The directory under the work directory where the extended canvas is written. */
export const EXTENDED_DIR = 'extended';

/** The edges the canvas may grow on. */
export const GROWABLE_EDGES = Object.freeze(['top', 'right', 'bottom', 'left']);
const MIN_PROMPT_LENGTH = 24;
const MIN_BAND_FILL = 0.5;

/**
 * The edges an answer names, as a list.
 *
 * The role may name one edge or several: a picture is often cut at two sides at once — a device
 * clipped at the top and another one clipped at the bottom — and growing only one of them leaves
 * the other cut in place.
 * @param {string|string[]|null|undefined} value the edge or the edges
 * @returns {string[]} the known edges, in the order they were named
 * @exports
 * @ai.hint pure
 */
export function edgeList(value) {
    const raw = Array.isArray(value) ? value : [value];
    const out = [];
    for (const item of raw) {
        const edge = String(item ?? '').trim().toLowerCase();
        if (GROWABLE_EDGES.includes(edge) && !out.includes(edge)) out.push(edge);
    }
    return out;
}

/**
 * The contract appended to the instruction written by the `extender` role.
 *
 * The role says what continues into the band. This says that the band is the only part the editor
 * may touch, so the source pixels stay measurable at their original scale.
 */
export const EXTENDER_FRAME = 'The attached picture is a reference image whose canvas has been made larger. '
    + 'Its original content stays exactly where it was, at its original size, and is already finished; '
    + 'the rest of the frame is empty. '
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
 * The band is a share of the long edge. The original picture keeps its size and its place inside the
 * new canvas, and the editor receives transparent pixels in the band of every named edge.
 * @param {{ width: number, height: number }} size
 * @param {number} padFraction
 * @param {string|string[]} edges the edges to grow
 * @returns {{ width: number, height: number, band: number, offsets: { top: number, right: number, bottom: number, left: number } }|null}
 */
export function extensionTarget(size, padFraction = 0.125, edges = 'bottom') {
    const width = Number(size?.width);
    const height = Number(size?.height);
    const fraction = Number(padFraction);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    if (!Number.isFinite(fraction) || fraction <= 0) return null;
    const list = edgeList(edges);
    if (!list.length) return null;
    const band = Math.max(1, Math.round(Math.max(width, height) * fraction));
    const offsets = {
        top: list.includes('top') ? band : 0,
        right: list.includes('right') ? band : 0,
        bottom: list.includes('bottom') ? band : 0,
        left: list.includes('left') ? band : 0,
    };
    return {
        width: width + offsets.left + offsets.right,
        height: height + offsets.top + offsets.bottom,
        band,
        offsets,
    };
}

/**
 * The rectangles of the new canvas that hold the painted band, one per grown edge.
 *
 * The top and the bottom band span the whole width, the left and the right band only the height of
 * the source, so the rectangles never overlap and together cover everything outside the source.
 * @param {{ width: number, height: number }} canvas the size of the new canvas
 * @param {{ width: number, height: number }} source the size of the original picture
 * @param {{ top?: number, right?: number, bottom?: number, left?: number }} offsets where the source sits in the canvas
 * @returns {Array<{ edge: string, x: number, y: number, width: number, height: number }>}
 * @exports
 * @ai.hint pure
 */
export function bandRects(canvas, source, offsets = {}) {
    const rects = [];
    const cw = Number(canvas?.width) || 0;
    const ch = Number(canvas?.height) || 0;
    const sw = Number(source?.width) || 0;
    const sh = Number(source?.height) || 0;
    const top = Math.max(0, Number(offsets?.top) || 0);
    const left = Math.max(0, Number(offsets?.left) || 0);
    const right = Math.max(0, Number(offsets?.right) || 0);
    const bottom = Math.max(0, Number(offsets?.bottom) || 0);
    if (top) rects.push({ edge: 'top', x: 0, y: 0, width: cw, height: top });
    if (bottom) rects.push({ edge: 'bottom', x: 0, y: top + sh, width: cw, height: ch - (top + sh) });
    if (left) rects.push({ edge: 'left', x: 0, y: top, width: left, height: sh });
    if (right) rects.push({ edge: 'right', x: left + sw, y: top, width: cw - (left + sw), height: sh });
    return rects;
}

/**
 * The side of a band rectangle that touches the source picture.
 * @param {string} edge the edge of the canvas the band belongs to
 * @returns {string} the side of the rectangle
 * @exports
 * @ai.hint pure
 */
export function bandInnerSide(edge) {
    if (edge === 'bottom') return 'top';
    if (edge === 'top') return 'bottom';
    if (edge === 'right') return 'left';
    return 'right';
}

/**
 * The rectangle that is cut out of the answer for one band.
 *
 * The band itself is the empty part of the canvas, but the patch carries a thin strip of the
 * source that touches it: the fade is laid over that strip, so the transition from the old pixels
 * to the new ones is smooth and no empty line is left between them.
 * @param {{ x: number, y: number, width: number, height: number }} rect the band
 * @param {string} side the side of the band that touches the source
 * @param {number} overlap how many pixels of the source the patch carries
 * @returns {{ x: number, y: number, width: number, height: number }}
 * @exports
 * @ai.hint pure
 */
export function bandPatchRect(rect, side, overlap) {
    const span = Math.max(0, Math.round(Number(overlap) || 0));
    const out = { ...rect };
    if (!span) return out;
    if (side === 'top') {
        out.y = rect.y - span;
        out.height = rect.height + span;
    } else if (side === 'bottom') {
        out.height = rect.height + span;
    } else if (side === 'left') {
        out.x = rect.x - span;
        out.width = rect.width + span;
    } else {
        out.width = rect.width + span;
    }
    return out;
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
 * @param {{ width: number, data: Buffer }} before the source picture
 * @param {{ width: number, data: Buffer }} after the answer, the bigger canvas
 * @param {number} width original width
 * @param {number} height original height
 * @param {{ edge?: string, fraction?: number, offsetX?: number, offsetY?: number }} [options]
 *   `offsetX`/`offsetY` say where the source sits inside the answer.
 * @returns {{ delta: number, meanDelta: number, changedShare: number, size: number }}
 */
export function seamDelta(before, after, width, height, {
    edge = 'bottom', fraction = 0.06, offsetX = 0, offsetY = 0,
} = {}) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const size = Math.max(1, Math.round((horizontal ? height : width) * Math.max(0, fraction)));
    let sum = 0;
    let changed = 0;
    let seen = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (edge === 'bottom' && y < height - size) continue;
            if (edge === 'top' && y >= size) continue;
            if (edge === 'right' && x < width - size) continue;
            if (edge === 'left' && x >= size) continue;
            const from = (y * before.width + x) * 4;
            const to = ((y + offsetY) * after.width + (x + offsetX)) * 4;
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
 * @param {string} edge the edge the band belongs to
 * @param {{ offsetX?: number, offsetY?: number }} [options] where the source sits in the answer
 * @returns {number}
 */
export function bandFillShare(after, width, height, edge = 'bottom', { offsetX = 0, offsetY = 0 } = {}) {
    let filled = 0;
    let seen = 0;
    for (let y = 0; y < after.height; y++) {
        for (let x = 0; x < after.width; x++) {
            if (edge === 'bottom') {
                if (y < offsetY + height) continue;
            } else if (edge === 'top') {
                if (y >= offsetY) continue;
            } else if (edge === 'right') {
                if (x < offsetX + width) continue;
                if (y < offsetY || y >= offsetY + height) continue;
            } else {
                if (x >= offsetX) continue;
                if (y < offsetY || y >= offsetY + height) continue;
            }
            if (after.data[(y * after.width + x) * 4 + 3] > 8) filled += 1;
            seen += 1;
        }
    }
    return seen ? filled / seen : 0;
}

/**
 * Fade the overlap at the source edge so the band does not meet it with a hard line.
 *
 * The band is cut out of the answer and laid over the untouched source, so the pixels of the band
 * that touch the source have to fade out — otherwise the seam shows as a line. The side names the
 * edge of the band that touches the source: `top` for a band under the picture, `bottom` for a band
 * above it, and so on.
 * @param {Buffer} bytes the bytes of the band
 * @param {string} side the side of the band that touches the source
 * @param {number} overlap how many pixels of the band fade out
 * @param {string} engine
 * @returns {Promise<Buffer>}
 */
export async function featherBand(bytes, side, overlap, engine) {
    const frame = await decodeRgba(bytes, engine);
    const horizontal = side === 'top' || side === 'bottom';
    const span = Math.max(1, Math.min(overlap, horizontal ? frame.height : frame.width));
    for (let i = 0; i < span; i++) {
        const weight = span <= 1 ? 1 : i / (span - 1);
        if (horizontal) {
            const row = side === 'top' ? i : frame.height - 1 - i;
            if (row < 0 || row >= frame.height) continue;
            for (let x = 0; x < frame.width; x++) {
                const at = (row * frame.width + x) * 4;
                frame.data[at + 3] = Math.round(frame.data[at + 3] * weight);
            }
            continue;
        }
        const column = side === 'left' ? i : frame.width - 1 - i;
        if (column < 0 || column >= frame.width) continue;
        for (let y = 0; y < frame.height; y++) {
            const at = (y * frame.width + column) * 4;
            frame.data[at + 3] = Math.round(frame.data[at + 3] * weight);
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
    const padFraction = Number(settings.padFraction ?? 0.125);
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
            notify({
                type: 'extend.decision',
                file: img,
                verdict: 'keep',
                edges: [],
                assessment: String(answer.data.assessment ?? '').trim(),
            });
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        // The role may name one edge or several: a picture cut at the top and at the bottom has to
        // grow both, otherwise the second cut stays in the file. Both fields are read, so an answer
        // that fills in only one of them is still understood.
        const edges = edgeList([
            ...(Array.isArray(answer.data.edges) ? answer.data.edges : []),
            answer.data.edge,
        ]);
        const prompt = String(answer.data.prompt ?? '').trim();
        if (!edges.length || prompt.length < MIN_PROMPT_LENGTH) {
            warnings.push(`extension: unusable extension plan for ${img} `
                + `(edges: ${edges.join(', ') || 'none'})`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const target = extensionTarget(before, padFraction, edges);
        if (!target) {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }
        notify({
            type: 'extend.decision',
            file: img,
            verdict: 'extend',
            edges,
            assessment: String(answer.data.assessment ?? '').trim(),
            band: target.band,
            before: { width: before.width, height: before.height },
            after: { width: target.width, height: target.height },
        });
        const padded = await rasterPadImageBytes({
            bytes,
            engine,
            targetWidth: target.width,
            targetHeight: target.height,
            offsetX: target.offsets.left,
            offsetY: target.offsets.top,
        });
        if (!padded?.padded) {
            warnings.push(`extension: local canvas did not grow for ${img}`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        let accepted = null;
        let lastReason = 'no answer';
        let hint = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            notify({ type: 'extend.attempt', file: img, attempt, maxAttempts, model: editorModel });
            let edited;
            try {
                edited = await client.images.edit({
                    model: editorModel,
                    prompt: extenderPrompt(hint ? `${prompt}\n\n${hint}` : prompt),
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

            // Every grown edge is measured on its own: the seam tells whether the source stayed
            // put, the fill tells whether the editor painted the band at all.
            let seam = null;
            let fill = 1;
            let rejected = null;
            for (const edge of edges) {
                const edgeSeam = seamDelta(before, after, before.width, before.height, {
                    edge,
                    fraction: seamFraction,
                    offsetX: padded.offsetX,
                    offsetY: padded.offsetY,
                });
                const edgeFill = bandFillShare(after, before.width, before.height, edge, {
                    offsetX: padded.offsetX,
                    offsetY: padded.offsetY,
                });
                if (!seam || edgeSeam.delta > seam.delta) seam = edgeSeam;
                fill = Math.min(fill, edgeFill);
                if (edgeSeam.delta > seamLimit) {
                    rejected = `the seam of the ${edge} band drifted by ${edgeSeam.delta.toFixed(3)} `
                        + `(limit ${seamLimit})`;
                    break;
                }
                if (edgeFill < MIN_BAND_FILL) {
                    rejected = `the ${edge} band is only ${Math.round(edgeFill * 100)}% filled`;
                    break;
                }
            }
            if (rejected) {
                lastReason = rejected;
                // The next attempt says what was wrong, so the editor can fill the band it left
                // empty instead of answering the same way again.
                hint = `The previous answer was refused: ${rejected}. Paint that band of the empty frame.`;
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
        const mergedAltAbs = path.join(scratchDir, `${index}-${stem}-merged2.png`);
        const outputAbs = path.join(extDir, path.basename(img));
        try {
            await writeFile(paddedAbs, padded.bytes);
            await writeFile(answerAbs, accepted.bytes);

            // Every band is cut out of the answer together with a thin strip of the source that
            // touches it, faded along that strip and laid over the untouched source, so the picture
            // keeps its own pixels at 1:1 and the seam does not show as a line.
            const rects = bandRects(
                { width: padded.width, height: padded.height },
                { width: before.width, height: before.height },
                target.offsets,
            );
            let baseAbs = paddedAbs;
            let merged = mergedAbs;
            for (const rect of rects) {
                const side = bandInnerSide(rect.edge);
                const span = side === 'top' || side === 'bottom' ? rect.height : rect.width;
                const source = side === 'top' || side === 'bottom' ? before.height : before.width;
                const overlap = Math.max(1, Math.min(span, Math.round(source * seamFraction)));
                const patch = bandPatchRect(rect, side, overlap);
                await rasterCrop({
                    input: answerAbs,
                    output: patchAbs,
                    x: patch.x,
                    y: patch.y,
                    width: patch.width,
                    height: patch.height,
                    cwd: root,
                    engine,
                });
                const feathered = await featherBand(
                    await readFile(patchAbs),
                    side,
                    overlap,
                    engine,
                );
                await writeFile(featheredAbs, feathered);
                const next = merged === mergedAbs ? mergedAltAbs : mergedAbs;
                await rasterPatch({
                    input: baseAbs,
                    patch: featheredAbs,
                    output: next,
                    x: patch.x,
                    y: patch.y,
                    width: patch.width,
                    height: patch.height,
                    cwd: root,
                    engine,
                    blend: true,
                });
                baseAbs = next;
                merged = next;
            }
            await writeFile(outputAbs, await readFile(baseAbs));

            const relativeOutput = path.relative(root, outputAbs) || path.basename(outputAbs);
            state.extended.push({
                from: img,
                to: relativeOutput,
                kept: false,
                edge: edges.length === 1 ? edges[0] : edges.join('+'),
                edges,
                band: { width: padded.width - before.width, height: padded.height - before.height },
                seamDelta: Number(accepted.seam.delta.toFixed(4)),
                fill: Number(accepted.fill.toFixed(4)),
            });
            state.canvas.push({
                from: img,
                to: relativeOutput,
                width: padded.width,
                height: padded.height,
                edge: edges.length === 1 ? edges[0] : edges.join('+'),
            });
            notify({
                type: 'extend.done',
                file: img,
                to: relativeOutput,
                edges,
                seamDelta: accepted.seam.delta,
                width: padded.width,
                height: padded.height,
            });
        } catch (error) {
            warnings.push(`extension: ${img} could not be stitched (${error?.message ?? error})`);
            state.extended.push({ from: img, to: img, kept: true });
        }
    }

    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    state.images = state.extended.map((entry) => entry.to);
    // The extended picture is the reference of the run: the stages that come after it cut the
    // collage out of it.
    state.references = state.extended.map((entry) => String(entry.to ?? '').replace(/\\/g, '/'));
}
