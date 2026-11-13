/**
 * @file src/stages/rectify.js
 * @module stages/rectify
 * @purpose Stage 2: level the screens the decompose stage cut out of the reference.
 *
 *   A projection is only as good as the four corners it was given, and a vision model eyeballs
 *   corners. So the role is never asked whether the picture looks straight: it is asked to place
 *   the corners, the deterministic projection is run on them, and the result is judged by the
 *   tilt that is still measurable in the pixels. A result that is not flatter than the source is
 *   deleted, and the source stays where it was.
 *
 *   The projection is also the cut. The tool maps the quad onto a rectangle of the quad's own
 *   size, so one call around one screen inside a collage returns that screen, flat, as its own
 *   file. A collage of three phones at different angles is therefore separated here.
 *
 * @depends node:path, node:fs/promises, agent/schemas, agent/paths, agent/tool-specs,
 *   image/raster, image/skew, openai/responses, openai/images, roles/index
 * @usedBy shared/pipeline
 * @exports runRectify, acceptsRectification, producedScreens, validateRectifiedFile,
 *   swapReferencePaths, RECTIFIED_DIR, MAX_RESIDUAL_DEG, MIN_IMPROVEMENT_DEG
 * @ai.tags rectification, perspective, screens
 * @ai.hint keep
 */

import path from 'node:path';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { RECTIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { toolSpecs } from '../agent/tool-specs.js';
import { rasterInfo } from '../image/raster.js';
import { measureResidualSkew } from '../image/skew.js';
import { imagePart } from '../openai/responses.js';
import { sniffImage } from '../openai/images.js';

/** Subdirectory of the work dir that holds the rectified copies. */
export const RECTIFIED_DIR = 'rectified';

/** Residual tilt above which the output is considered still skewed. */
export const MAX_RESIDUAL_DEG = 0.8;

/** Residual tilt below which the output is considered flat enough. */
export const MIN_IMPROVEMENT_DEG = 0.4;

/** The tools the rectifier may call: geometry and verification, nothing else. */
const RECTIFIER_TOOLS = ['view_image', 'correct_perspective', 'compare_images'];

/** What the role is told when the picture has to be cut screen by screen. */
const SPLIT_NOTE = [
    'This picture carries more than one screen. Cut it screen by screen: one correct_perspective call',
    'per screen, with the four corners of that screen, and one output file per screen.',
].join(' ');

/**
 * Is the rectified output acceptable: less residual tilt than the source, or the source was flat.
 * @param {{ angleDeg: number, confidence: number, best: number, flat: number }} sourceResult
 * @param {{ angleDeg: number, confidence: number, best: number, flat: number }} result
 * @param {number} [maxDeg] residual tilt that counts as flat
 * @param {number} [minImprovement] how much flatter the result has to be
 * @returns {{ ok: boolean, reason: string }}
 * @ai.hint pure
 */
export function acceptsRectification(sourceResult, result, maxDeg = MAX_RESIDUAL_DEG, minImprovement = MIN_IMPROVEMENT_DEG) {
    const sourceAngle = Math.abs(sourceResult?.angleDeg ?? 0);
    const resultAngle = Math.abs(result?.angleDeg ?? 0);

    // Few straight boundaries on both sides: neither the residual nor the improvement is
    // trustworthy, and the source is not degraded by an extra warp.
    if ((sourceResult?.confidence ?? 0) < 0.15 && (result?.confidence ?? 0) < 0.15) {
        return { ok: true, reason: 'no measurable boundaries — the source is not degraded' };
    }
    if (resultAngle <= maxDeg) {
        return { ok: true, reason: `residual ${resultAngle.toFixed(1)}° — the screen is level` };
    }
    if (resultAngle >= sourceAngle - minImprovement) {
        return {
            ok: false,
            reason: `not enough improvement: ${sourceAngle.toFixed(1)}° → ${resultAngle.toFixed(1)}° `
                + `(at least ${(sourceAngle - minImprovement).toFixed(1)}°)`,
        };
    }
    return { ok: true, reason: `improved: ${sourceAngle.toFixed(1)}° → ${resultAngle.toFixed(1)}°` };
}

/**
 * The files the role claims to have produced, as a list.
 *
 * The schema asks for `screens[]`, one entry per screen, because a collage returns several files.
 * A model that answers in the older single-file shape (`output` + `quad` at the top level) is
 * folded into that list rather than discarded — the work is in the file it wrote, and losing a
 * correct projection to a shape mismatch would leave the skewed reference in place.
 * @param {object|null} data the parsed rectifier answer
 * @returns {Array<{ label: string, output: string, quad: object|null }>}
 * @ai.hint pure
 */
export function producedScreens(data) {
    const list = (Array.isArray(data?.screens) ? data.screens : [])
        .map((entry) => ({
            label: String(entry?.label ?? '').trim(),
            output: String(entry?.output ?? '').trim(),
            quad: entry?.quad ?? null,
        }))
        .filter((entry) => entry.output);
    if (list.length) return list;
    const output = String(data?.output ?? '').trim();
    return output ? [{ label: '', output, quad: data?.quad ?? null }] : [];
}

/**
 * Verify that a rectified file is valid: exists, is a file, is not empty, sits inside the output
 * directory.
 * @param {string} filePath absolute path
 * @param {string} outputDir absolute path of the output directory
 * @returns {Promise<{ ok: boolean, reason: string, size?: number }>}
 * @ai.hint io
 */
export async function validateRectifiedFile(filePath, outputDir) {
    const value = String(filePath ?? '').trim();
    if (!value) return { ok: false, reason: 'no path given' };
    const abs = path.resolve(value);
    if (abs !== outputDir && !abs.startsWith(outputDir + path.sep)) {
        return { ok: false, reason: `the file is outside the output directory (${outputDir})` };
    }
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return { ok: false, reason: 'the output file was not found' };
    if (!info.size) return { ok: false, reason: 'the output file is empty' };
    return { ok: true, size: info.size };
}

/**
 * Re-point a list of reference paths at the rectified copies.
 *
 * One source can produce several screens — a collage is cut one quad at a time — so an entry is
 * replaced by the whole list of files produced from it, in place, and the list grows.
 * @param {string[]} paths reference paths
 * @param {Array<{ from: string, to: string }>} rectified the accepted files
 * @returns {{ paths: string[], swapped: Array<{ from: string, to: string }> }}
 * @ai.hint pure
 */
export function swapReferencePaths(paths = [], rectified = []) {
    if (!rectified.length) return { paths: [...paths], swapped: [] };
    const byPath = new Map();
    for (const item of rectified) {
        const from = toPosix(String(item?.from ?? '').trim());
        const to = toPosix(String(item?.to ?? '').trim());
        if (!from || !to) continue;
        if (!byPath.has(from)) byPath.set(from, []);
        const list = byPath.get(from);
        if (!list.includes(to)) list.push(to);
    }
    const swapped = [];
    const next = [];
    for (const item of paths) {
        const rel = toPosix(String(item ?? '').trim());
        const produced = byPath.get(rel);
        if (!produced) {
            next.push(item);
            continue;
        }
        for (const file of produced) {
            next.push(file);
            swapped.push({ from: item, to: file });
        }
    }
    return { paths: next, swapped };
}

/**
 * Ask the rectifier role about one reference.
 * @param {{ root: string, roles: object, file: { rel: string, abs: string }, frame: object,
 *   outDirRel: string, extraTools: object[]|null, model: string|null, effort: string|null,
 *   maxTurns: number, note?: string }} params
 * @returns {Promise<object>} the answer of the role runner
 * @ai.hint io
 */
async function askRectifier({ root, roles, file, frame, outDirRel, extraTools, model, effort, maxTurns, note = '' }) {
    const bytes = await readFile(file.abs);
    const text = [
        `Reference: ${file.rel}`,
        `Size: ${frame.width}×${frame.height} pixels. Every coordinate you place belongs to this file.`,
        `Write any corrected file under ${outDirRel}/ — nowhere else, and never over the reference itself.`,
        '',
        'Say whether this picture needs a projection, and if it does, place the corners of every screen it',
        'carries and project each one separately: one correct_perspective call per screen cuts that screen',
        'out and levels it in the same step, because the tool maps your quad onto a rectangle of the quad\'s',
        'own size.',
        note ? `\n${note}` : '',
    ].filter(Boolean).join('\n');
    return await roles.run('rectifier', {
        text,
        parts: [imagePart(bytes, sniffImage(bytes).mime)],
        instructions: ROLE_INSTRUCTIONS.rectifier,
        schema: RECTIFY_SCHEMA,
        schemaName: 'rectifyPlan',
        maxTurns,
        extraTools,
        model,
        effort,
    });
}

/**
 * The screens the stage works on: the files the decompose stage produced, or the images of the
 * state when the stage runs on its own.
 * @param {object} state pipeline state
 * @param {string} root project root
 * @returns {Array<{ rel: string, abs: string }>}
 * @ai.hint pure
 */
function inputFiles(state, root) {
    if (Array.isArray(state.screensFiles) && state.screensFiles.length) {
        return state.screensFiles.map((file) => ({
            rel: toPosix(file.rel),
            abs: file.abs ?? path.resolve(root, file.rel),
        }));
    }
    return (state.images ?? []).map((rel) => ({ rel: toPosix(rel), abs: path.resolve(root, rel) }));
}

/**
 * Run the rectify stage.
 *
 * Every screen goes through the role, the projection and the measurement. A screen that comes
 * back level replaces its source; a screen that does not stays where it was, and the file the
 * role wrote is deleted.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function runRectify(state, notify = () => {}) {
    const { root, workDir, config, roles, model, effort, warnings, toolset } = state;
    const files = inputFiles(state, root);
    if (!files.length) {
        warnings.push('rectify: no screens to rectify');
        return;
    }

    const settings = config.stages?.rectify ?? {};
    const engine = config.raster?.engine ?? 'auto';
    const maxResidualDeg = Number.isFinite(settings.residualSkewLimitDeg) ? settings.residualSkewLimitDeg : MAX_RESIDUAL_DEG;
    const minImprovementDeg = Number.isFinite(settings.minImprovementDeg) ? settings.minImprovementDeg : MIN_IMPROVEMENT_DEG;
    const maxTurns = Number.isSafeInteger(settings.maxTurns) ? settings.maxTurns : 24;
    const maxSplitTurns = Number.isSafeInteger(settings.maxSplitTurns) ? settings.maxSplitTurns : 32;
    const maxAttempts = Number.isSafeInteger(settings.maxAttempts) ? Math.max(1, settings.maxAttempts) : 2;

    const outDir = path.join(root, workDir, RECTIFIED_DIR);
    await mkdir(outDir, { recursive: true });
    toolset?.setWriteDirs?.([outDir]);
    const outDirRel = toPosix(path.join(workDir, RECTIFIED_DIR));

    const extraTools = toolset?.specsFor
        ? toolset.specsFor('rectifier', RECTIFIER_TOOLS)
        : toolSpecs(config.tools ?? {}, {
            role: 'rectifier',
            names: RECTIFIER_TOOLS,
            imageApi: Boolean(state.client?.images),
        });

    const rectified = [];
    const kept = [];

    for (const file of files) {
        const located = await resolveInside(root, file.rel, { allowRoot: false }).catch(() => null);
        if (!located) {
            warnings.push(`rectify: ${file.rel} is outside the working directory`);
            continue;
        }
        const frame = await rasterInfo(located.abs, { cwd: root, engine }).catch(() => null);
        if (!frame?.width || !frame?.height) {
            warnings.push(`rectify: cannot read ${file.rel}`);
            kept.push({ from: file.rel, kept: true, reason: 'the file cannot be read' });
            continue;
        }

        const sourceSkew = await measureResidualSkew(located.abs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 })
            .catch(() => null);

        let accepted = [];
        let kind = 'project';
        let note = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await askRectifier({
                root,
                roles,
                file: { rel: file.rel, abs: located.abs },
                frame,
                outDirRel,
                extraTools,
                model,
                effort,
                maxTurns: kind === 'split' ? maxSplitTurns : maxTurns,
                note,
            });

            if (!result?.data) {
                warnings.push(`rectify: ${file.rel}: the rectifier did not answer `
                    + `(${result?.error ?? result?.status ?? 'unknown'}); the frame stays as it is`);
                kept.push({ from: file.rel, kept: true, reason: 'the rectifier did not answer' });
                break;
            }
            if (result.data.verdict === 'keep') {
                kept.push({ from: file.rel, kept: true, reason: result.data.assessment || 'the frame is level' });
                break;
            }

            const produced = producedScreens(result.data);
            if (!produced.length) {
                if (attempt < maxAttempts) {
                    kind = 'split';
                    note = SPLIT_NOTE;
                    continue;
                }
                kept.push({ from: file.rel, kept: true, reason: result.data.assessment || 'no file in screens' });
                break;
            }

            let residual = null;
            for (const entry of produced) {
                const outputAbs = path.isAbsolute(entry.output) ? path.resolve(entry.output) : path.resolve(root, entry.output);
                const valid = await validateRectifiedFile(outputAbs, outDir);
                if (!valid.ok) {
                    warnings.push(`rectify: ${file.rel}: the result "${entry.output}" was not accepted — ${valid.reason}`);
                    continue;
                }
                const to = toPosix(path.relative(root, outputAbs));
                if (to === file.rel) {
                    warnings.push(`rectify: ${file.rel}: the rectifier returned the path of the source — `
                        + 'the original file is never overwritten');
                    continue;
                }

                const resultSkew = await measureResidualSkew(outputAbs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 })
                    .catch(() => null);
                if (resultSkew && sourceSkew) {
                    const accept = acceptsRectification(sourceSkew, resultSkew, maxResidualDeg, minImprovementDeg);
                    if (!accept.ok) {
                        warnings.push(`rectify: ${to}: the screen was not accepted — ${accept.reason}`);
                        await unlink(outputAbs).catch(() => {});
                        residual = resultSkew.angleDeg;
                        continue;
                    }
                }

                notify({
                    type: 'rectify.file',
                    file: to,
                    from: file.rel,
                    screen: entry.label,
                    before: sourceSkew?.angleDeg ?? null,
                    after: resultSkew?.angleDeg ?? null,
                });
                accepted.push({
                    from: file.rel,
                    to,
                    screen: entry.label,
                    before: sourceSkew?.angleDeg ?? null,
                    after: resultSkew?.angleDeg ?? null,
                    confidence: resultSkew?.confidence ?? null,
                    assessment: result.data.assessment ?? '',
                });
            }

            if (accepted.length) break;
            if (attempt < maxAttempts) {
                kind = residual === null ? 'split' : 'project';
                note = residual === null
                    ? SPLIT_NOTE
                    : `The previous result still measured ${residual.toFixed(1)}° of tilt. Place the corners `
                        + 'again, a little wider, and project the screen once more.';
                continue;
            }
            kept.push({ from: file.rel, kept: true, reason: 'no screen passed the tilt check' });
        }

        rectified.push(...accepted);
    }

    state.rectified.push(...rectified, ...kept);

    // The accepted files replace their sources: the screens point at the level copies, and the
    // reference list of the next stage points at them too.
    const byFrom = new Map();
    for (const item of rectified) {
        if (!byFrom.has(item.from)) byFrom.set(item.from, []);
        byFrom.get(item.from).push(item);
    }
    if (byFrom.size && Array.isArray(state.screens)) {
        const screens = [];
        for (const screen of state.screens) {
            const produced = byFrom.get(screen.subReference);
            if (!produced?.length) {
                screens.push(screen);
                continue;
            }
            if (produced.length === 1) {
                screens.push({ ...screen, subReference: produced[0].to, subReferenceKind: 'restored' });
                continue;
            }
            produced.forEach((item, index) => {
                screens.push({
                    ...screen,
                    name: item.screen || `${screen.name}-${index + 1}`,
                    subReference: item.to,
                    subReferenceKind: 'restored',
                });
            });
        }
        state.screens = screens;
    }

    if (Array.isArray(state.screensFiles) && state.screensFiles.length) {
        const files2 = [];
        for (const screen of state.screens ?? []) {
            if (!screen.subReference) continue;
            const abs = path.resolve(root, screen.subReference);
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) continue;
            files2.push({
                rel: screen.subReference,
                abs,
                bytes: info.size,
                screen: screen.name,
                kind: screen.subReferenceKind || 'crop',
                source: screen.source ?? '',
                note: '',
            });
        }
        if (files2.length) state.screensFiles = files2;
    }

    const current = state.images?.length
        ? state.images
        : (state.screens ?? []).map((screen) => screen.subReference).filter(Boolean);
    state.images = swapReferencePaths(current, rectified).paths;

    notify({ type: 'rectify.done', count: rectified.length });
}
