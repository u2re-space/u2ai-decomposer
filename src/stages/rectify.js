/**
 * @file src/stages/rectify.js
 * @purpose Stage: rectify screens (Phase 1 from archive/rectify.js).
 * @exports runRectify
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { RECTIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { rasterInfo } from '../image/raster.js';

const RECTIFIED_DIR = 'rectified';
const MAX_RESIDUAL_DEG = 0.8;
const MIN_IMPROVEMENT_DEG = 0.4;

/**
 * Accept rectification based on residual tilt improvement.
 */
function acceptsRectification(sourceResult, result, maxDeg = MAX_RESIDUAL_DEG, minImprove = MIN_IMPROVEMENT_DEG) {
    const s = Math.abs(sourceResult.angleDeg);
    const r = Math.abs(result.angleDeg);
    if (sourceResult.confidence < 0.15 && result.confidence < 0.15) return { ok: true, reason: 'no measurable boundaries' };
    if (r <= maxDeg) return { ok: true, reason: `residual ${r.toFixed(1)}° — flat` };
    if (r >= s - minImprove) return { ok: false, reason: `insufficient improvement: ${s.toFixed(1)}° → ${r.toFixed(1)}°` };
    return { ok: true, reason: `improved: ${s.toFixed(1)}° → ${r.toFixed(1)}°` };
}

/**
 * Run the rectify stage.
 * @param {object} state
 * @param {Function} notify
 */
export async function runRectify(state, notify = () => {}) {
    const { root, workDir, config, roles, model, effort, screensFiles, warnings } = state;
    const files = screensFiles?.length ? screensFiles : state.images.map((img) => ({ rel: img, abs: path.resolve(root, img) }));
    if (!files.length) return;

    const outDir = path.join(root, workDir, RECTIFIED_DIR);
    await mkdir(outDir, { recursive: true });

    for (const file of files) {
        const abs = file.abs ?? path.resolve(root, file.rel);
        let frame;
        try { frame = await rasterInfo(abs, { cwd: root, engine: config.image?.rasterEngine ?? 'auto' }); }
        catch { warnings.push(`rectify: cannot read ${file.rel}`); continue; }

        const fileBytes = await readFile(abs);
        const result = await roles.run('rectifier', {
            text: `Reference: ${file.rel}\nSize: ${frame.width}×${frame.height}.\nWrite corrected files under ${workDir}/${RECTIFIED_DIR}/.\nSay whether this picture needs a projection.`,
            parts: [{ type: 'input_image', source: { type: 'base64', data: fileBytes.toString('base64'), media_type: 'image/png' } }],
            instructions: ROLE_INSTRUCTIONS.rectifier,
            schema: RECTIFY_SCHEMA, schemaName: 'rectifyPlan',
            maxTurns: 6, model, effort,
        });

        if (!result.data || result.data.verdict !== 'rectified') {
            state.rectified.push({ from: file.rel, kept: true });
            continue;
        }

        const screens = Array.isArray(result.data.screens) ? result.data.screens : [];
        for (const screen of screens) {
            const output = String(screen.output ?? '').trim();
            if (!output) continue;
            const outputAbs = path.isAbsolute(output) ? output : path.join(root, output);
            const info = await stat(outputAbs).catch(() => null);
            if (!info?.isFile() || !info.size) {
                warnings.push(`rectify: ${output} not found or empty`);
                continue;
            }
            state.rectified.push({ from: file.rel, to: path.relative(root, outputAbs).replace(/[\\/]/g, '/'), screen: screen.label });
        }
    }

    // Update images list for subsequent stages.
    if (state.rectified.some((r) => r.to)) {
        state.images = state.rectified.filter((r) => r.to).map((r) => r.to);
    }
    notify({ type: 'rectify.done', count: state.rectified.filter((r) => r.to).length });
}