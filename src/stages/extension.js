/**
 * @file src/stages/extension.js
 * @purpose Stage: extend reference frame (Phase 0.5 from archive/extend.js).
 * @exports runExtension
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { rasterPadImageBytes, decodeRgba, rasterCrop, rasterPatch } from '../image/raster.js';
import { paddedSizeToMinPixels, IMAGE_SIZES, sniffImage, imageModelFor } from '../openai/images.js';
import { EXTEND_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';

const EXTENDED_DIR = 'extended';
const GROWABLE_EDGES = new Set(['bottom', 'right', '']);
const MAX_SEAM_DELTA = 6;
const MAX_SEAM_CHANGED_SHARE = 0.05;
const MIN_BAND_FILL = 0.5;
const SEAM_ROWS = 8;

/**
 * Seam-based verdict: accept full answer or only the band.
 */
function extensionVerdict(originalDelta, seamDelta) {
    if (Number.isFinite(originalDelta?.meanDelta) && originalDelta.meanDelta <= 3 && originalDelta.changedShare <= 0.01) {
        return { ok: true, mode: 'whole', reason: 'original unchanged' };
    }
    if (Number.isFinite(seamDelta?.meanDelta) && seamDelta.meanDelta <= MAX_SEAM_DELTA && seamDelta.changedShare <= MAX_SEAM_CHANGED_SHARE) {
        return { ok: true, mode: 'band', reason: `seam matched (delta ${seamDelta.meanDelta.toFixed(1)})` };
    }
    return { ok: false, mode: 'reject', reason: `frame repainted (original ${originalDelta.meanDelta.toFixed(1)}, seam ${seamDelta.meanDelta.toFixed(1)})` };
}

function seamDeltaCalc(before, after, width, height, rows = 8) {
    const start = Math.max(0, height - rows);
    let sum = 0, changed = 0, seen = 0;
    for (let y = start; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = (y * before.width + x) * 4;
            const to = (y * after.width + x) * 4;
            const d = Math.abs(before.data[from] - after.data[to])
                    + Math.abs(before.data[from+1] - after.data[to+1])
                    + Math.abs(before.data[from+2] - after.data[to+2]);
            sum += d / 3;
            if (d > 12) changed++;
            seen++;
        }
    }
    return { meanDelta: seen ? sum / seen : Infinity, changedShare: seen ? changed / seen : 1 };
}

function bandFillShare(after, top) {
    let filled = 0, seen = 0;
    for (let y = Math.max(0, Math.round(top)); y < after.height; y++) {
        for (let x = 0; x < after.width; x++) {
            if (after.data[(y * after.width + x) * 4 + 3] > 8) filled++;
            seen++;
        }
    }
    return seen ? filled / seen : 0;
}

/**
 * Run the extension stage.
 * @param {object} state pipeline state
 * @param {Function} notify
 */
export async function runExtension(state, notify = () => {}) {
    const { root, images, workDir, config, client, roles, model, effort, imageModel, dryRun, warnings } = state;
    if (!client?.images) {
        warnings.push('extension: images API unavailable, skipping');
        return;
    }
    const editorModel = imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) {
        warnings.push('extension: no image model configured, skipping');
        return;
    }

    const extDir = path.join(root, workDir, EXTENDED_DIR);
    await mkdir(extDir, { recursive: true });

    for (const img of images) {
        const abs = path.resolve(root, img);
        let bytes;
        try { bytes = await readFile(abs); } catch { warnings.push(`extension: cannot read ${img}`); continue; }

        const decoded = await decodeRgba(bytes, { engine: config.image?.rasterEngine ?? 'auto' });
        const { width, height } = decoded;

        // Ask the extender role.
        const result = await roles.run('extender', {
            text: `Reference: ${img}\nSize: ${width}×${height} pixels.\nSay whether the frame cuts real content, and write the instruction for the band.`,
            parts: [{ type: 'input_image', source: { type: 'base64', data: bytes.toString('base64'), media_type: sniffImage(bytes).mime } }],
            instructions: ROLE_INSTRUCTIONS.extender,
            schema: EXTEND_SCHEMA, schemaName: 'extendPlan', maxTurns: 1,
            model, effort,
        });

        if (!result.data || result.data.verdict !== 'extend') {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        const plan = result.data;
        const edge = String(plan.edge ?? '').trim().toLowerCase();
        if (!GROWABLE_EDGES.has(edge) || String(plan.prompt ?? '').length < 24) {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        // Pad the canvas.
        const target = paddedSizeToMinPixels({ width, height }, editorModel);
        const padded = await rasterPadImageBytes({ bytes, engine: config.image?.rasterEngine ?? 'auto', targetWidth: target?.width ?? width, targetHeight: target?.height ?? height });
        if (!padded?.padded) {
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        // Ask the editor.
        const payloads = await client.images.edit({
            model: editorModel,
            prompt: `${plan.prompt}\n\nThe attached picture is a reference whose canvas has been made larger. Draw only into the empty part.`,
            size: `${padded.width}x${padded.height}`,
            format: 'png',
            files: [{ filename: path.basename(img), mime: sniffImage(padded.bytes).mime, bytes: padded.bytes }],
        });

        if (!Array.isArray(payloads) || !payloads.length) {
            warnings.push(`extension: empty answer for ${img}`);
            continue;
        }

        const answerBytes = Buffer.from(payloads[0], 'base64');
        const after = await decodeRgba(answerBytes, { engine: config.image?.rasterEngine ?? 'auto' });

        // Verify seam.
        const seam = seamDeltaCalc(decoded, after, width, height, SEAM_ROWS);
        const verdict = extensionVerdict({ meanDelta: 0, changedShare: 0 }, seam);
        if (!verdict.ok) {
            warnings.push(`extension: ${img} rejected (${verdict.reason})`);
            state.extended.push({ from: img, to: img, kept: true });
            continue;
        }

        // Write output.
        const outName = path.basename(img);
        const outPath = path.join(extDir, outName);
        await writeFile(outPath, answerBytes);
        state.extended.push({ from: img, to: path.join(workDir, EXTENDED_DIR, outName), mode: verdict.mode });
        notify({ type: 'extend.done', file: img, to: outPath });
    }

    // Replace images list with extended versions for subsequent stages.
    if (state.extended.some((e) => !e.kept)) {
        state.images = state.extended.map((e) => e.to);
    }
}