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
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { RECTIFY_REPAIR_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { measureResidualSkew } from '../image/skew.js';
import { applyHomography, perspectiveRectify, solveHomography } from '../image/rectify.js';
import { rasterCrop, rasterInfo, rasterPatch } from '../image/raster.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';
import { runRectify, referenceFiles, opaqueShare, quadCorners, swapReferencePaths } from './rectify.js';
import { editFragment, prefersStartPicture, verifyRepair } from './repair.js';
import { editorPrompt, pickPatches, planFragment } from './restore-plan.js';

/** Subdirectory of the work dir that holds the straightened references. */
export const STRAIGHTENED_DIR = 'straightened';

/** Subdirectory of the work dir that holds the repaired screens. */
export const REPAIRED_DIR = 'repaired';

/** The tools the repairer of the ai-mode may call: it looks and compares, the harness edits. */
export const REPAIR_TOOLS = ['view_image', 'compare_images'];

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

    // The third part: the AI repairs the fragments that are still broken. The screens of the
    // geometry cut are the input of the repair, and the repaired copies are what the next stage
    // reads.
    await repairCuts({
        state: aiState,
        notify,
        client,
        roles: state.roles,
        model: state.model,
        effort: state.effort,
        editorModel,
        settings,
        engine,
        root,
        workDir,
        warnings,
    });

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
 * Repair the screens of the geometry cut with the AI.
 *
 * Every screen is asked about separately: the role names the broken regions of that screen, the
 * harness cuts them out, sends them to the editor one by one and stitches the answers back into
 * exactly their boxes. A repair that the second look does not call better is thrown away, and the
 * screen keeps the bytes it had.
 * @param {{ state: object, notify: Function, client: object, roles: object, model: string|null,
 *   effort: string|null, editorModel: string, settings: object, engine: string, root: string,
 *   workDir: string, warnings: string[] }} params
 * @returns {Promise<void>}
 * @ai.hint io
 */
async function repairCuts({
    state, notify, client, roles, model, effort, editorModel, settings, engine, root, workDir, warnings,
}) {
    const files = Array.isArray(state.screensFiles) ? state.screensFiles : [];
    if (!files.length) return;

    const maxPasses = Number.isSafeInteger(settings.maxRepairPasses) ? Math.max(1, settings.maxRepairPasses) : 2;
    const maxPatches = Number.isSafeInteger(settings.maxPatches) ? Math.max(1, settings.maxPatches) : 3;
    const boxPadding = Number.isSafeInteger(settings.boxPadding) ? Math.max(0, settings.boxPadding) : 16;
    const maxAttempts = Number.isSafeInteger(settings.maxAttempts) ? Math.max(1, settings.maxAttempts) : 2;
    const quality = settings.quality ?? null;

    // The corners every screen was cut by, and the file it was cut from.
    const quads = new Map();
    const cutFrom = new Map();
    for (const item of state.rectified ?? []) {
        if (!item?.to) continue;
        if (!quads.has(item.to)) quads.set(item.to, item.quad ?? null);
        if (!cutFrom.has(item.to)) cutFrom.set(item.to, item.from);
    }

    const outDir = path.join(root, workDir, REPAIRED_DIR);
    const scratchRoot = path.join(root, workDir, '.repair');
    await mkdir(outDir, { recursive: true });
    /** The names the repaired screens took, so that two screens never share one file. */
    const usedNames = new Set();

    for (const [index, file] of files.entries()) {
        const rel = toPosix(file.rel);
        const abs = file.abs ?? path.resolve(root, rel);
        const quad = quads.get(rel) ?? null;
        const sourceRel = toPosix(String(cutFrom.get(rel) ?? file.source ?? '').trim());
        // The picture the role compares the screen with: the reference the screen was cut from.
        const compareRel = sourceRel && sourceRel !== rel ? sourceRel : toPosix(String(file.source ?? '').trim());
        const compareAbs = await locate(root, compareRel);
        const result = await repairScreen({
            file: { rel, abs },
            quad,
            compareAbs,
            root,
            workDir,
            outDir,
            target: uniqueName(outDir, path.basename(rel), usedNames),
            scratch: path.join(scratchRoot, String(index + 1)),
            notify,
            client,
            roles,
            model,
            effort,
            editorModel,
            engine,
            warnings,
            maxPasses,
            maxPatches,
            boxPadding,
            maxAttempts,
            quality,
        });
        if (!result?.repaired) continue;

        // The repaired screen replaces the cut one: the state of the run points at it.
        const info = await stat(result.abs).catch(() => null);
        const replaced = {
            ...file,
            rel: result.rel,
            abs: result.abs,
            bytes: info?.size ?? file.bytes,
            kind: 'repaired',
        };
        const at = files.findIndex((item) => toPosix(item.rel) === rel);
        if (at >= 0) files[at] = replaced;
        for (const screen of state.screens ?? []) {
            if (toPosix(screen.subReference ?? '') !== rel) continue;
            screen.subReference = result.rel;
            screen.subReferenceKind = 'repaired';
        }
        state.images = (state.images ?? []).map((item) => (toPosix(item) === rel ? result.rel : item));
        notify({
            type: 'rectify.repair.file',
            file: result.rel,
            from: rel,
            patches: result.patches,
        });
    }
    await rm(scratchRoot, { recursive: true, force: true });
}

/**
 * A file of the output directory that no other screen of the run took.
 * @param {string} outDir the output directory
 * @param {string} name the wanted name
 * @param {Set<string>} used the names that are taken
 * @returns {string} the absolute path of the file
 * @ai.hint pure
 */
function uniqueName(outDir, name, used) {
    const stem = name.replace(/\.png$/i, '');
    let candidate = `${stem}.png`;
    let n = 2;
    while (used.has(candidate)) {
        candidate = `${stem}-${n}.png`;
        n += 1;
    }
    used.add(candidate);
    return path.join(outDir, candidate);
}

/**
 * Repair one screen: ask the role, cut the fragments it named, and keep only what is better.
 * @param {{ file: { rel: string, abs: string }, quad: object|null, compareAbs: string|null,
 *   root: string, workDir: string, outDir: string, target: string, scratch: string, notify: Function,
 *   client: object, roles: object, model: string|null, effort: string|null, editorModel: string,
 *   engine: string, warnings: string[], maxPasses: number, maxPatches: number, boxPadding: number,
 *   maxAttempts: number, quality: string|null }} params
 * @returns {Promise<{ repaired: boolean, rel: string, abs: string, patches: number }|null>}
 * @ai.hint io
 */
async function repairScreen({
    file, quad, compareAbs, root, workDir, outDir, target, scratch, notify, client, roles, model, effort,
    editorModel, engine, warnings, maxPasses, maxPatches, boxPadding, maxAttempts, quality,
}) {
    const frame = await rasterInfo(file.abs, { cwd: root, engine }).catch(() => null);
    if (!frame?.width || !frame?.height) return null;
    await mkdir(scratch, { recursive: true });

    let currentAbs = file.abs;
    const applied = [];
    let refused = false;

    for (let pass = 1; pass <= maxPasses; pass++) {
        const plan = await askRepairer({
            roles, file, abs: currentAbs, frame, compareAbs, model, effort, pass, maxPasses, repaired: applied,
        });
        if (!plan?.data) {
            warnings.push(`rectify: ${file.rel}: the repair plan was not read `
                + `(${plan?.error ?? plan?.status ?? 'unknown'}); the screen stays as it is`);
            break;
        }
        const wanted = Array.isArray(plan.data.patches) ? plan.data.patches : [];
        const accepted = pickPatches(wanted, {
            frameWidth: frame.width,
            frameHeight: frame.height,
            maxPatches,
            taken: applied.map((item) => item.region ?? item.box),
        });
        for (const rejected of accepted.rejected) {
            warnings.push(`rectify: ${file.rel}: the region `
                + `(${rejected.patch.x},${rejected.patch.y}) ${rejected.patch.width}×${rejected.patch.height} `
                + `was refused — ${rejected.reason}`);
        }
        if (!accepted.patches.length) break;

        notify({
            type: 'rectify.repair.start',
            file: file.rel,
            patches: accepted.patches.length,
            pass,
        });

        let repaired = 0;
        for (const [index, patch] of accepted.patches.entries()) {
            const box = planFragment(patch, {
                frameWidth: frame.width,
                frameHeight: frame.height,
                margin: boxPadding,
            });
            const fragmentAbs = path.join(scratch, `${pass}-${index + 1}-fragment.png`);
            const editedAbs = path.join(scratch, `${pass}-${index + 1}-edited.png`);
            const mergedAbs = path.join(scratch, `${pass}-${index + 1}-merged.png`);
            try {
                // The editor works on the picture the stage started with when the model redraws
                // what it is given; otherwise it works on the result of the repairs before it.
                const editorSource = prefersStartPicture(editorModel) ? file.abs : currentAbs;
                const source = patch.source === 'reference' && quad
                    ? await cutFromReference({
                        quad, frame, box, referenceAbs: compareAbs, output: fragmentAbs, root, engine,
                    })
                    : null;
                if (!source) {
                    await rasterCrop({
                        input: editorSource,
                        output: fragmentAbs,
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        cwd: root,
                        engine,
                    });
                }
                const fragment = await readFile(fragmentAbs);
                const edited = await editFragment({
                    client,
                    editorModel,
                    prompt: editorPrompt(patch.prompt),
                    filename: path.basename(fragmentAbs),
                    bytes: fragment,
                    maxAttempts,
                    quality,
                });
                if (!edited) {
                    warnings.push(`rectify: ${file.rel}: region ${index + 1} was not repaired`);
                    continue;
                }
                await writeFile(editedAbs, edited);
                const merged = await rasterPatch({
                    input: currentAbs,
                    patch: editedAbs,
                    output: mergedAbs,
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                    cwd: root,
                    engine,
                });
                const check = await verifyRepair({ roles, before: currentAbs, after: mergedAbs, root, model, effort })
                    .catch((error) => ({ verdict: 'worse', reason: error?.message ?? String(error) }));
                if (check.verdict !== 'better') {
                    warnings.push(`rectify: ${file.rel}: the repair was refused by the verification `
                        + `(${check.verdict}: ${check.reason}) — the screen is left as it was`);
                    refused = true;
                    break;
                }
                applied.push({
                    kind: patch.kind,
                    source: patch.source === 'reference' ? 'reference' : 'screen',
                    box: merged.box,
                    region: { x: patch.x, y: patch.y, width: patch.width, height: patch.height },
                    finding: patch.finding,
                    prompt: patch.prompt,
                });
                currentAbs = mergedAbs;
                repaired += 1;
            } catch (error) {
                warnings.push(`rectify: ${file.rel}: region ${index + 1} was not repaired `
                    + `(${error?.message ?? error})`);
            } finally {
                await unlink(fragmentAbs).catch(() => {});
                await unlink(editedAbs).catch(() => {});
                if (currentAbs !== mergedAbs) await unlink(mergedAbs).catch(() => {});
            }
        }
        // A pass that brought nothing ends the screen: there is nothing to build on.
        if (refused || !repaired) break;
    }

    if (!applied.length) return { repaired: false, rel: file.rel, abs: file.abs, patches: 0 };

    // The repaired screen is a file of its own: the geometry result stays where it is.
    await writeFile(target, await readFile(currentAbs));
    return { repaired: true, rel: toPosix(path.relative(root, target)), abs: target, patches: applied.length };
}

/**
 * Ask the repairer what is broken in one screen.
 *
 * The role sees the screen as it is now — the result of the repairs before it — and the reference
 * it was cut from, so that it can tell a broken region from a deliberate part of the design.
 * @param {{ roles: object, file: { rel: string, abs: string }, abs: string, frame: object,
 *   compareAbs: string|null, model: string|null, effort: string|null, pass: number,
 *   maxPasses: number, repaired: object[] }} params
 * @returns {Promise<object>} the answer of the role runner
 * @ai.hint io
 */
async function askRepairer({ roles, file, abs, frame, compareAbs, model, effort, pass, maxPasses, repaired }) {
    const bytes = await readFile(abs);
    const parts = [imagePart(bytes, sniffImage(bytes).mime)];
    if (compareAbs) {
        const original = await readFile(compareAbs).catch(() => null);
        if (original) parts.push(imagePart(original, sniffImage(original).mime));
    }
    const done = pass > 1
        ? [
            `Pass ${pass} of ${maxPasses}: the picture you see is the result of the repairs before it.`,
            ...repaired.map((item) => `  ${item.kind}: ${item.box.x},${item.box.y} `
                + `${item.box.width}×${item.box.height} — ${item.finding || item.kind}`),
            'Name only what is still broken: a region that was repaired already is not to be named again.',
        ].join('\n')
        : '';
    const text = [
        `Screen: ${file.rel}`,
        `Size of the screen: ${frame.width}×${frame.height} pixels. Every coordinate you return belongs to this file.`,
        parts.length > 1
            ? 'The second picture is the reference this screen was cut from, for comparison only.'
            : '',
        done,
        '',
        'Name what is broken in this screen and write the editor instruction for every region.',
        'Say for every region whether its pixels come from the screen itself or from the reference.',
    ].filter(Boolean).join('\n');
    return await roles.run('rectifyRepair', {
        text,
        parts,
        instructions: ROLE_INSTRUCTIONS.rectifyRepair,
        schema: RECTIFY_REPAIR_SCHEMA,
        schemaName: 'rectifyRepair',
        maxTurns: 1,
        model,
        effort,
    });
}

/**
 * The corners of a region of the screen in the coordinates of the reference.
 *
 * The corners of the screen are known — they are the corners the geometry cut it by — so a region
 * of the screen is mapped back onto the reference through the same homography, and the reference
 * can be cut there.
 * @param {object} quad the corners of the screen in the reference
 * @param {{ width: number, height: number }} frame the size of the screen
 * @param {{ x: number, y: number, width: number, height: number }} box the region of the screen
 * @returns {Array<{x:number,y:number}>|null} the corners in the reference, or null when the quad is
 *   unusable
 * @exports
 * @ai.hint pure
 */
export function mapBoxToReference(quad, frame, box) {
    const corners = quadCorners(quad);
    if (!corners) return null;
    const src = [
        { x: 0, y: 0 },
        { x: frame.width, y: 0 },
        { x: 0, y: frame.height },
        { x: frame.width, y: frame.height },
    ];
    const h = solveHomography(src, corners);
    const mapped = [
        applyHomography(h, box.x, box.y),
        applyHomography(h, box.x + box.width, box.y),
        applyHomography(h, box.x, box.y + box.height),
        applyHomography(h, box.x + box.width, box.y + box.height),
    ];
    if (mapped.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
    return mapped;
}

/**
 * Cut the region of the reference that belongs to a region of the screen.
 *
 * The corners of the screen are known — they are the corners the geometry cut it by — so the
 * region of the screen is mapped back onto the reference through the same homography, and the
 * reference is cut there. The fragment comes out at the size of the box, so the answer of the
 * editor is stitched back without a change of scale.
 * @param {{ quad: object, frame: object, box: object, referenceAbs: string|null, output: string,
 *   root: string, engine: string }} params
 * @returns {Promise<boolean>} whether the fragment was cut
 * @ai.hint io
 */
async function cutFromReference({ quad, frame, box, referenceAbs, output, root, engine }) {
    if (!referenceAbs) return false;
    const mapped = mapBoxToReference(quad, frame, box);
    if (!mapped) return false;
    try {
        await perspectiveRectify({
            input: referenceAbs,
            output,
            quad: mapped,
            outputSize: { width: box.width, height: box.height },
            cwd: root,
            engine,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * The file of a path inside the working directory, or null when it is not there.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string|null>}
 * @ai.hint io
 */
async function locate(root, rel) {
    if (!rel) return null;
    const located = await resolveInside(root, rel, { allowRoot: false }).catch(() => null);
    if (!located) return null;
    const info = await stat(located.abs).catch(() => null);
    return info?.isFile() ? located.abs : null;
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
