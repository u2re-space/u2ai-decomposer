/**
 * @file src/stages/reconstruct.js
 * @purpose Stage: restore lost details (Phase 1.5 from archive/restore.js).
 * @exports runReconstruct
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile, writeFile, unlink, rm, copyFile } from 'node:fs/promises';
import { RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { rasterCrop, rasterPatch, rasterInfo, decodeRgba } from '../image/raster.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';

const RESTORED_DIR = 'restored';
const MAX_PATCH_COVERAGE = 0.45;
const MIN_FRAGMENT_SIDE = 64;
const FRAGMENT_MARGIN = 24;

/**
 * Plan a fragment box from a patch description.
 */
function planFragment(patch, { frameWidth, frameHeight, margin = FRAGMENT_MARGIN, minSide = MIN_FRAGMENT_SIDE }) {
    const clamp = (v, max) => Math.max(0, Math.min(Math.round(v), max));
    let x = clamp(patch.x - margin, frameWidth - 1);
    let y = clamp(patch.y - margin, frameHeight - 1);
    let width = Math.min(Math.round(patch.width + margin * 2), frameWidth - x);
    let height = Math.min(Math.round(patch.height + margin * 2), frameHeight - y);
    const grown = width < minSide || height < minSide;
    if (width < minSide) { x -= Math.min(x, Math.ceil((minSide - width) / 2)); width = Math.min(minSide, frameWidth - x); }
    if (height < minSide) { y -= Math.min(y, Math.ceil((minSide - height) / 2)); height = Math.min(minSide, frameHeight - y); }
    return { x, y, width: Math.max(1, width), height: Math.max(1, height), grown };
}

/**
 * Run the reconstruct stage.
 * @param {object} state
 * @param {Function} notify
 */
export async function runReconstruct(state, notify = () => {}) {
    const { root, workDir, config, client, roles, model, effort, imageModel, images, warnings } = state;
    if (!client?.images) {
        warnings.push('reconstruct: images API unavailable, skipping');
        return;
    }
    const editorModel = imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) { warnings.push('reconstruct: no image model, skipping'); return; }

    const outDir = path.join(root, workDir, RESTORED_DIR);
    await mkdir(outDir, { recursive: true });

    const files = images.map((img) => ({ rel: img, abs: path.resolve(root, img) }));

    for (const file of files) {
        const frame = await rasterInfo(file.abs, { cwd: root, engine: config.raster?.engine ?? 'auto' }).catch(() => null);
        if (!frame?.width) { warnings.push(`reconstruct: cannot read ${file.rel}`); continue; }

        const bytes = await readFile(file.abs);
        const result = await roles.run('restorer', {
            text: `Sub-reference: ${file.rel}\nSize: ${frame.width}×${frame.height}.\nName what blocks measurement.`,
            parts: [imagePart(bytes, sniffImage(bytes).mime)],
            instructions: ROLE_INSTRUCTIONS.restorer,
            schema: RESTORE_SCHEMA, schemaName: 'restorePlan', maxTurns: 1, model, effort,
        });

        if (!result.data || result.data.verdict !== 'repair') {
            state.restored.push({ from: file.rel, to: file.rel, kept: true });
            continue;
        }

        const patches = result.data.patches ?? [];
        let currentAbs = file.abs;
        for (const [i, patch] of patches.entries()) {
            const box = planFragment(patch, { frameWidth: frame.width, frameHeight: frame.height });
            try {
                const fragAbs = path.join(root, workDir, `.tmp-frag-${i}.png`);
                await rasterCrop({ input: currentAbs, output: fragAbs, ...box, cwd: root, engine: config.raster?.engine });
                const fragBytes = await readFile(fragAbs);
                const edited = await client.images.edit({
                    model: editorModel,
                    prompt: `${patch.prompt}\n\nThe attached file is a fragment. Return same size, same scale, only the named thing changed.`,
                    format: 'png',
                    image: { filename: `frag-${i}.png`, mime: 'image/png', bytes: fragBytes },
                });
                if (edited?.images?.length) {
                    const editAbs = path.join(root, workDir, `.tmp-edit-${i}.png`);
                    await writeFile(editAbs, edited.images[0].bytes);
                    const mergeAbs = path.join(root, workDir, `.tmp-merge-${i}.png`);
                    await rasterPatch({ input: currentAbs, patch: editAbs, output: mergeAbs, ...box, cwd: root, engine: config.raster?.engine });
                    currentAbs = mergeAbs;
                    await unlink(fragAbs).catch(() => {});
                    await unlink(editAbs).catch(() => {});
                }
            } catch (e) {
                warnings.push(`reconstruct: patch ${i+1} failed for ${file.rel}: ${e.message}`);
            }
        }

        const outName = path.basename(file.rel);
        const outAbs = path.join(outDir, outName);
        await copyFile(currentAbs, outAbs);
        state.restored.push({ from: file.rel, to: path.join(workDir, RESTORED_DIR, outName) });
        notify({ type: 'reconstruct.file', file: file.rel, to: outAbs });
    }

    if (state.restored.some((r) => r.to !== r.from)) {
        state.images = state.restored.filter((r) => r.to).map((r) => r.to);
    }
}