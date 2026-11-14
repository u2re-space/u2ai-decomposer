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
 *   swapReferencePaths, quadCorners, screenFileName, projectQuad, opaqueShare, referenceFiles,
 *   cropOfReference, RECTIFIED_DIR, MAX_RESIDUAL_DEG, MIN_IMPROVEMENT_DEG, RECTIFIER_TOOLS
 * @ai.tags rectification, perspective, screens
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { RECTIFY_SCHEMA, RECTIFY_REVIEW_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { toolSpecs } from '../agent/tool-specs.js';
import { rasterInfo, decodeRgba } from '../image/raster.js';
import { perspectiveRectify } from '../image/rectify.js';
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
export const RECTIFIER_TOOLS = ['view_image', 'correct_perspective', 'compare_images'];

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
        // A screen with corners but without a path is still a screen: the stage projects it and
        // names the file itself.
        .filter((entry) => entry.output || entry.quad);
    if (list.length) return list;
    const output = String(data?.output ?? '').trim();
    return output || data?.quad ? [{ label: '', output, quad: data?.quad ?? null }] : [];
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
 * Share of the pixels of a file that carry something.
 *
 * A projection of a wrong quad comes out mostly transparent: the homography asked for pixels the
 * picture does not have. Such a file is not a screen.
 * @param {string} filePath absolute path
 * @param {string} engine
 * @returns {Promise<number>}
 * @ai.hint io
 */
export async function opaqueShare(filePath, engine = 'auto') {
    const bytes = await readFile(filePath).catch(() => null);
    if (!bytes) return 0;
    const frame = await decodeRgba(bytes, engine).catch(() => null);
    if (!frame?.width || !frame?.height) return 0;
    let filled = 0;
    for (let at = 3; at < frame.data.length; at += 4) {
        if (frame.data[at] > 8) filled += 1;
    }
    return filled / (frame.width * frame.height);
}

/**
 * The four corners of an answer as the array the projection wants.
 *
 * The role answers with the corners named (`tl`, `tr`, `br`, `bl`); the projection wants them in
 * the order top-left, top-right, bottom-left, bottom-right.
 * @param {object|null} quad the quad of the answer
 * @returns {Array<{x:number,y:number}>|null}
 * @exports
 * @ai.hint pure
 */
export function quadCorners(quad) {
    if (!quad || typeof quad !== 'object') return null;
    /**
     * One corner of the quad.
     * @param {object} point the corner
     * @returns {{x:number,y:number}|null}
     */
    const pick = (point) => {
        const x = Number(point?.x);
        const y = Number(point?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    };
    const tl = pick(quad.tl);
    const tr = pick(quad.tr);
    const br = pick(quad.br);
    const bl = pick(quad.bl);
    if (!tl || !tr || !br || !bl) return null;
    return [tl, tr, bl, br];
}

/**
 * A file name for a screen of the answer: the label of the screen, safe to be a name.
 * @param {string} label the label the role gave
 * @param {number} index the number of the screen in the answer
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function screenFileName(label, index) {
    const stem = String(label ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'screen';
    return `${String(index + 1).padStart(2, '0')}-${stem}.png`;
}

/**
 * Project the corners of one screen and write the result into the output directory.
 *
 * The corners are the hard part of the work and the projection is deterministic, so the stage does
 * the projection itself when the role named the corners but did not write the file. A model that
 * answers with the plan and forgets the tool call would otherwise leave the stage with nothing.
 * @param {{ source: string, outDir: string, label: string, quad: object|null, index: number,
 *   name?: string|null, cwd: string, engine?: string }} params
 * @returns {Promise<string|null>} the absolute path of the written file, or null when the corners
 *   are unusable
 * @ai.hint io
 */
export async function projectQuad({
    source, outDir, label, quad, index, name = null, cwd, engine = 'auto',
}) {
    const corners = quadCorners(quad);
    if (!corners) return null;
    const fileName = name && /\.png$/i.test(name) ? path.basename(name) : screenFileName(label, index);
    const output = path.join(outDir, fileName);
    try {
        await perspectiveRectify({ input: source, output, quad: corners, cwd, engine });
    } catch {
        return null;
    }
    return output;
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
 * Ask the rectifier role to look at the screens it produced.
 *
 * A cut is easy to get wrong in a way nobody notices: the corners land on the content instead of
 * on the edge of the display, and the screen that comes out is a few pixels too narrow — a title
 * runs out of the frame, the margin of the display is gone. The role sees the reference and the
 * cuts side by side, so it can say which screen was cut off and place the corners again.
 * @param {{ root: string, roles: object, file: { rel: string, abs: string }, frame: object,
 *   outDirRel: string, extraTools: object[]|null, model: string|null, effort: string|null,
 *   maxTurns: number, cuts: Array<{ to: string }> }} params
 * @returns {Promise<object>} the answer of the role runner
 * @ai.hint io
 */
async function reviewCuts({
    root, roles, file, frame, outDirRel, extraTools, model, effort, maxTurns, cuts,
}) {
    const bytes = await readFile(file.abs);
    const parts = [imagePart(bytes, sniffImage(bytes).mime)];
    const names = [];
    for (const cut of cuts) {
        const cutBytes = await readFile(path.resolve(root, cut.to)).catch(() => null);
        if (!cutBytes) continue;
        parts.push(imagePart(cutBytes, sniffImage(cutBytes).mime));
        names.push(cut.to);
    }
    const text = [
        `Reference: ${file.rel}`,
        `Size: ${frame.width}×${frame.height} pixels. Every coordinate you place belongs to this file.`,
        '',
        'The first picture is the reference. The pictures after it are the screens you cut out of it:',
        ...names.map((name, index) => `  ${index + 1}. ${name}`),
        '',
        'Look at every cut: is any part of the screen missing — the margin of the display, the status',
        'bar, a title, a card or a row that runs out of the frame? A cut that is too narrow loses the',
        'edges of the screen, and the reader of the result sees a chopped screen.',
        'If every screen is complete, answer "ok" and name nothing.',
        'If a screen was cut off, answer "recut", name that screen with the same label as before, and',
        'place its four corners again, wider than before: on the outer edge of the display area of the',
        'device, outside the display rather than inside the content. Project it again, or name the',
        'corners and the stage will project them.',
    ].join('\n');
    return await roles.run('rectifier', {
        text,
        parts,
        instructions: ROLE_INSTRUCTIONS.rectifier,
        schema: RECTIFY_REVIEW_SCHEMA,
        schemaName: 'rectifyReview',
        maxTurns,
        extraTools,
        model,
        effort,
    });
}

/**
 * The name of a screen, as the role writes it and as the stage compares it.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 * @ai.hint pure
 */
function sameLabel(a, b) {
    const left = String(a ?? '').trim().toLowerCase();
    const right = String(b ?? '').trim().toLowerCase();
    return Boolean(left) && left === right;
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
            ...file,
            rel: toPosix(file.rel),
            abs: file.abs ?? path.resolve(root, file.rel),
        }));
    }
    return (state.images ?? []).map((rel) => ({ rel: toPosix(rel), abs: path.resolve(root, rel) }));
}

/**
 * The pictures the run started from: the reference, extended when it had to be.
 *
 * The reference is the ground truth of a collage. The decompose stage cuts it into sub-references
 * with the eyes of a model, and a model that reads a collage of three phones as two flat screens
 * cuts it in the wrong place. The rectifier works on the whole picture and names the corners of
 * every screen it holds, so the reference is what the stage cuts.
 * @param {object} state pipeline state
 * @param {string} root project root
 * @returns {Array<{ rel: string, abs: string }>}
 * @ai.hint pure
 */
export function referenceFiles(state, root) {
    const rels = Array.isArray(state.references) && state.references.length
        ? state.references
        : (state.images ?? []);
    return rels.map((rel) => ({ rel: toPosix(rel), abs: path.resolve(root, rel) }));
}

/**
 * Is this sub-reference a plain crop of one of the references?
 *
 * A crop carries nothing the reference does not have, so the reference is cut instead of it. A
 * sub-reference that was regenerated, repaired or exported from another source is not a crop: it
 * carries work of its own and is worked on as it is.
 * @param {{ rel: string, kind?: string, source?: string }} file the sub-reference
 * @param {Array<{ rel: string }>} references the references of the run
 * @returns {{ rel: string }|null} the reference the file was cut from
 * @ai.hint pure
 */
export function cropOfReference(file, references) {
    if (!file) return null;
    const kind = String(file.kind ?? 'crop').trim();
    if (kind && kind !== 'crop') return null;
    const source = toPosix(String(file.source ?? '').trim());
    if (!source) return null;
    return references.find((reference) => (
        source === reference.rel
        || source.endsWith(`/${reference.rel}`)
        || reference.rel.endsWith(`/${source}`)
    )) ?? null;
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
    const references = referenceFiles(state, root);
    const screens = inputFiles(state, root);
    if (!references.length && !screens.length) {
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
    // The role looks at its own cut and says whether a screen lost its edges.
    const review = settings.review !== false;

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

    /**
     * Work on one picture: ask the role about it, project the screens it named, keep what passed.
     * @param {{ rel: string, abs: string }} file the picture to work on
     * @returns {Promise<object[]>} the screens that were accepted
     */
    const processUnit = async (file) => {
        const accepted = [];
        const located = await resolveInside(root, file.rel, { allowRoot: false }).catch(() => null);
        if (!located) {
            warnings.push(`rectify: ${file.rel} is outside the working directory`);
            return accepted;
        }
        const frame = await rasterInfo(located.abs, { cwd: root, engine }).catch(() => null);
        if (!frame?.width || !frame?.height) {
            warnings.push(`rectify: cannot read ${file.rel}`);
            kept.push({ from: file.rel, kept: true, reason: 'the file cannot be read' });
            return accepted;
        }

        const sourceSkew = await measureResidualSkew(located.abs, { maxSide: 900, maxAngleDeg: 15, stepDeg: 0.1 })
            .catch(() => null);

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
            const missing = [];
            for (const [index, entry] of produced.entries()) {
                let outputAbs = path.isAbsolute(entry.output) ? path.resolve(entry.output) : path.resolve(root, entry.output);
                let valid = await validateRectifiedFile(outputAbs, outDir);
                if (!valid.ok) {
                    // The role named the corners but did not write the file. The projection is
                    // deterministic, so the stage does it: the screen is cut out and levelled even
                    // when the model answered with the plan and forgot the tool call.
                    const projected = await projectQuad({
                        source: located.abs,
                        outDir,
                        label: entry.label,
                        quad: entry.quad,
                        index,
                        name: path.basename(entry.output ?? ''),
                        cwd: root,
                        engine,
                    });
                    if (projected) {
                        outputAbs = projected;
                        valid = await validateRectifiedFile(outputAbs, outDir);
                        if (valid.ok) {
                            notify({
                                type: 'rectify.projected',
                                file: toPosix(path.relative(root, outputAbs)),
                                screen: entry.label,
                            });
                        }
                    }
                }
                if (!valid.ok) {
                    // The file is missing and the corners could not be projected: the model has to
                    // place them again, and the reader has to know what was wrong.
                    const reason = valid.reason === 'the output file was not found'
                        ? 'the file was not written and the corners could not be projected'
                        : valid.reason;
                    warnings.push(`rectify: ${file.rel}: the result "${entry.output}" was not accepted — ${reason}`);
                    missing.push(`${entry.output} (${reason})`);
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
                // A projection of wrong corners comes out empty: that is not a screen.
                const filled = await opaqueShare(outputAbs, engine);
                if (filled < 0.5) {
                    warnings.push(`rectify: ${to}: the screen was not accepted — the projection is empty `
                        + `(${Math.round(filled * 100)}% of the file carries pixels)`);
                    await unlink(outputAbs).catch(() => {});
                    continue;
                }
                // The tilt gate protects a single screen from being warped. When one picture is cut
                // into several screens, the projection is the cut itself and the tilt of the whole
                // collage says nothing about the screens it holds.
                if (resultSkew && sourceSkew && produced.length === 1) {
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
                if (missing.length) {
                    // The model named the files but wrote nothing: it has to call the tool, or name
                    // the corners so that the stage can project them.
                    kind = 'split';
                    note = `These results were refused: ${missing.join('; ')}. Call correct_perspective for every `
                        + 'screen of this picture and name the four corners of each screen in your answer as well, so the '
                        + 'screen can be cut out and levelled even if the tool call does not come through. The corners '
                        + 'belong to the interface of the screen, inside the picture: 0 to '
                        + `${frame.width} across and 0 to ${frame.height} down.`;
                    continue;
                }
                kind = residual === null ? 'split' : 'project';
                note = residual === null
                    ? SPLIT_NOTE
                    : `The previous result still measured ${residual.toFixed(1)}° of tilt. Place the corners `
                        + 'again, a little wider, and project the screen once more.';
                continue;
            }
            kept.push({ from: file.rel, kept: true, reason: 'no screen passed the tilt check' });
        }

        // The cut is checked by the role itself: a screen that lost its edges is cut again.
        if (accepted.length && review) {
            const answer = await reviewCuts({
                root,
                roles,
                file: { rel: file.rel, abs: located.abs },
                frame,
                outDirRel,
                extraTools,
                model,
                effort,
                maxTurns,
                cuts: accepted,
            }).catch(() => null);
            const wanted = answer?.data?.verdict === 'recut' ? producedScreens(answer.data) : [];
            for (const [index, entry] of wanted.entries()) {
                const target = accepted.find((item) => sameLabel(item.screen, entry.label)) ?? accepted[index];
                if (!target) continue;
                const targetAbs = path.resolve(root, target.to);
                const before = await readFile(targetAbs).catch(() => null);
                const beforeFrame = before ? await rasterInfo(targetAbs, { cwd: root, engine }).catch(() => null) : null;
                let written = null;
                if (entry.quad) {
                    written = await projectQuad({
                        source: located.abs,
                        outDir,
                        label: target.screen || entry.label,
                        quad: entry.quad,
                        index,
                        name: path.basename(target.to),
                        cwd: root,
                        engine,
                    });
                } else if (entry.output) {
                    // The role wrote the file itself: it is the new cut, and it replaces the old one.
                    const abs = path.isAbsolute(entry.output) ? path.resolve(entry.output) : path.resolve(root, entry.output);
                    const valid = await validateRectifiedFile(abs, outDir);
                    if (valid.ok) {
                        await writeFile(targetAbs, await readFile(abs));
                        written = targetAbs;
                    }
                }
                if (!written) continue;
                const filled = await opaqueShare(written, engine);
                if (filled < 0.5) {
                    // The re-cut is empty: the old cut stays where it was.
                    if (before) await writeFile(targetAbs, before);
                    warnings.push(`rectify: ${target.to}: the re-cut was not accepted — the projection is empty`);
                    continue;
                }
                const afterFrame = await rasterInfo(written, { cwd: root, engine }).catch(() => null);
                if (beforeFrame?.width && afterFrame?.width
                    && afterFrame.width * afterFrame.height < beforeFrame.width * beforeFrame.height) {
                    // A screen that lost its edges is cut too narrow; a re-cut that is smaller than
                    // the cut it replaces is not a repair.
                    if (before) await writeFile(targetAbs, before);
                    warnings.push(`rectify: ${target.to}: the re-cut was smaller than the cut it replaces — `
                        + 'the old cut stays');
                    continue;
                }
                notify({ type: 'rectify.recut', file: target.to, screen: target.screen });
            }
        }

        return accepted;
    };

    // The reference is cut into screens, and the crops the decompose stage made of it are replaced
    // by that cut. When the reference cannot be cut, the crops are the screens after all.
    const cropsOf = new Map();
    for (const file of screens) {
        const reference = cropOfReference(file, references);
        if (!reference) continue;
        if (!cropsOf.has(reference.rel)) cropsOf.set(reference.rel, []);
        cropsOf.get(reference.rel).push(file);
    }

    for (const reference of references) {
        const crops = cropsOf.get(reference.rel) ?? [];
        // A reference without crops was not cut by the decompose stage: it is one screen, and the
        // decompose output is the screen that was made of it.
        if (!crops.length && screens.length) continue;
        const accepted = await processUnit(reference);
        if (!accepted.length) {
            // The reference could not be cut: the crops of it are worked on as they are.
            for (const crop of crops) rectified.push(...await processUnit(crop));
            continue;
        }
        rectified.push(...accepted);
        // The crops of the reference are the screens the reference was cut into.
        for (const crop of crops) {
            for (const item of accepted) rectified.push({ ...item, from: crop.rel });
        }
    }

    // The sub-references that carry work of their own are worked on as they are.
    for (const file of screens) {
        if (cropOfReference(file, references)) continue;
        rectified.push(...await processUnit(file));
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
