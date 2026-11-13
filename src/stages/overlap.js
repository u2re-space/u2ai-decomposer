/**
 * @file src/stages/overlap.js
 * @purpose Stage: remove overlapping elements between screens via AI comparison.
 * @exports runOverlap
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { rasterCrop, rasterPatch, rasterInfo, decodeRgba } from '../image/raster.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';

const OVERLAP_DIR = 'overlap';

/**
 * Run the overlap stage: compare screens, remove foreign elements.
 * @param {object} state
 * @param {Function} notify
 */
export async function runOverlap(state, notify = () => {}) {
    const { root, workDir, config, client, roles, model, effort, imageModel, images, warnings } = state;
    if (images.length < 2) return; // overlap only makes sense with multiple screens

    const outDir = path.join(root, workDir, OVERLAP_DIR);
    await mkdir(outDir, { recursive: true });

    const editorModel = imageModel || imageModelFor(config, { hasImage: true });

    // Ask the overlap role to compare all screens.
    const parts = [];
    for (const img of images) {
        const abs = path.resolve(root, img);
        try {
            const bytes = await readFile(abs);
            parts.push(imagePart(bytes, sniffImage(bytes).mime));
        } catch {}
    }

    const result = await roles.run('overlap', {
        text: `Screens: ${images.join(', ')}\nCompare these screens and identify overlapping foreign elements.`,
        parts,
        instructions: ROLE_INSTRUCTIONS.overlap,
        maxTurns: 1, model, effort,
    });

    if (!result.data || result.data.verdict === 'clean') {
        state.overlapResolved = images.map((img) => ({ from: img, to: img, kept: true }));
        return;
    }

    // Apply overlap patches.
    const patches = result.data.patches ?? [];
    for (const img of images) {
        const abs = path.resolve(root, img);
        const frame = await rasterInfo(abs, { cwd: root, engine: config.raster?.engine ?? 'auto' }).catch(() => null);
        if (!frame) continue;

        let currentAbs = abs;
        for (const [i, patch] of patches.entries()) {
            if (patch.screen !== path.basename(img, path.extname(img))) continue;
            if (!client?.images || !editorModel) break;
            try {
                const box = patch.box ?? { x: patch.x, y: patch.y, width: patch.width, height: patch.height };
                const fragAbs = path.join(root, workDir, `.tmp-overlap-${i}.png`);
                await rasterCrop({ input: currentAbs, output: fragAbs, ...box, cwd: root });
                const fragBytes = await readFile(fragAbs);
                const edited = await client.images.edit({
                    model: editorModel,
                    prompt: `${patch.prompt}\n\nThis is a fragment from one screen. Remove the foreign content and continue the screen's own background/style.`,
                    format: 'png',
                    image: { filename: 'frag.png', mime: 'image/png', bytes: fragBytes },
                });
                if (edited?.images?.length) {
                    const editAbs = path.join(root, workDir, `.tmp-overlap-edit-${i}.png`);
                    await writeFile(editAbs, edited.images[0].bytes);
                    const mergeAbs = path.join(outDir, path.basename(img));
                    await rasterPatch({ input: currentAbs, patch: editAbs, output: mergeAbs, ...box, cwd: root });
                    currentAbs = mergeAbs;
                }
            } catch (e) {
                warnings.push(`overlap: patch ${i+1} failed for ${img}: ${e.message}`);
            }
        }

        const outName = path.basename(img);
        const finalPath = path.join(outDir, outName);
        if (currentAbs !== abs) {
            await writeFile(finalPath, await readFile(currentAbs));
            state.overlapResolved.push({ from: img, to: path.join(workDir, OVERLAP_DIR, outName) });
        } else {
            state.overlapResolved.push({ from: img, to: img, kept: true });
        }
    }

    if (state.overlapResolved.some((r) => r.to !== r.from)) {
        state.images = state.overlapResolved.filter((r) => r.to).map((r) => r.to);
    }
    notify({ type: 'overlap.done', count: state.overlapResolved.filter((r) => r.to !== r.from).length });
}