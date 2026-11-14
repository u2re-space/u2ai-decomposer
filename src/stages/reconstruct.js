/**
 * @file src/stages/reconstruct.js
 * @module stages/reconstruct
 * @purpose Stage 3: repair the screens that the deterministic path cannot fix — a strip of a
 *          neighbour that came with the crop, a bezel or a finger, the wedge an earlier rotation
 *          left, a control the frame cut in half — without redrawing the screen.
 *
 *   Why the repair is a cut-out and not a full-screen edit. The decompose stage already put every
 *   pixel where it belongs; what it cannot do is remove content that does not belong to the screen.
 *   Sending the whole screen to a generative editor throws the deterministic work away: the model
 *   redraws every glyph, drifts the palette and moves elements where its sampler landed, and the
 *   measurer then reads that drawing as the design. So the harness cuts the box the `restorer` role
 *   named, sends only that fragment, and stitches the answer back into exactly that box. Every
 *   pixel outside the box is copied from the untouched source.
 *
 *   The instruction sent to the editor is written by the `restorer` role, per region, after it has
 *   looked at this particular picture. What the harness adds is the contract the fragment travels
 *   under — it is a cut-out, keep its scale, change only the named thing.
 *
 *   The geometry is the other half of the stage, and it is deliberately not AI work. The role names
 *   the tilt in degrees and the size deviation in percent; the harness then turns those numbers
 *   into a rotation and a scale of the pixels themselves (`image/geometry`), so no glyph is
 *   redrawn. The correction is kept only when the measurement says the screen became flatter, and
 *   it is rolled back when it did not. The rounded corners of the display are the AI's part: they
 *   are pixels that belong to the device and not to the content, and only the editor can continue
 *   the content into them.
 *
 * @depends node:path, node:fs/promises, agent/schemas, agent/paths, image/raster, openai/images,
 *   openai/responses, roles/index, stages/restore-plan
 * @usedBy shared/pipeline
 * @exports runReconstruct, RESTORED_DIR
 * @ai.tags restoration, screens, fragments
 * @ai.hint keep
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { rasterCrop, rasterInfo, rasterPatch } from '../image/raster.js';
import { applyGeometry } from '../image/geometry.js';
import { defaults } from '../config/defaults.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';
import { FRAGMENT_MARGIN, editorPrompt, pickPatches, planFragment } from './restore-plan.js';

/** Directory under the work directory where the repaired copies are written. */
export const RESTORED_DIR = 'restored';

/**
 * The screens the stage works on: the files the rectify stage produced, or the images of the state
 * when the stage runs on its own.
 * @param {object} state pipeline state
 * @param {string} root project root
 * @returns {Array<{ rel: string, abs: string, screen: string, kind: string, source: string, note: string }>}
 * @ai.hint pure
 */
function inputFiles(state, root) {
    const list = Array.isArray(state.screensFiles) && state.screensFiles.length
        ? state.screensFiles
        : (state.images ?? []).map((rel) => ({ rel }));
    return list.map((file) => ({
        rel: toPosix(file.rel),
        abs: file.abs ?? path.resolve(root, file.rel),
        screen: file.screen ?? '',
        kind: file.kind ?? 'crop',
        source: file.source ?? '',
        note: file.note ?? '',
    }));
}

/**
 * Attach the picture the screen was cut from, so the role can tell a neighbour's strip from the
 * screen itself.
 * @param {string} root project root
 * @param {string} source the path the screen was cut from
 * @returns {Promise<object|null>} the image part, or null when the source cannot be found
 * @ai.hint io
 */
async function sourcePart(root, source) {
    if (!source) return null;
    const located = await resolveInside(root, source, { allowRoot: false }).catch(() => null);
    if (!located) return null;
    const bytes = await readFile(located.abs).catch(() => null);
    if (!bytes) return null;
    return imagePart(bytes, sniffImage(bytes).mime);
}

/**
 * Ask the restorer role what blocks the measurement of this screen.
 * @param {{ roles: object, file: object, frame: object, original: object|null, model: string|null,
 *   effort: string|null }} params
 * @returns {Promise<object>} the answer of the role runner
 * @ai.hint io
 */
async function askRestorer({ roles, file, frame, original, model, effort }) {
    const bytes = await readFile(file.abs);
    const resolved = roles.resolve?.('restorer');
    const parts = [imagePart(bytes, sniffImage(bytes).mime)];
    if (original) parts.push(original);
    const text = [
        `Sub-reference: ${file.rel}`,
        `Screen: ${file.screen || '(unnamed)'}`,
        `Produced by: ${file.kind}${file.note ? ` — ${file.note}` : ''}`,
        `Source: ${file.source || '(unknown)'}`,
        `Size of the sub-reference: ${frame.width}×${frame.height} pixels. Every coordinate you return belongs to this file.`,
        original ? 'The second image is the original reference this file was cut or rectified from, for comparison only.' : '',
        '',
        'Name what stops this file from being measured, and write the editor instruction for each region.',
        'Say as well how far the content is tilted and how far its size differs from the truth — the geometry is reported, not fixed by you.',
    ].filter(Boolean).join('\n');
    return await roles.run('restorer', {
        text,
        parts,
        instructions: resolved?.instructions ?? ROLE_INSTRUCTIONS.restorer,
        schema: RESTORE_SCHEMA,
        schemaName: 'restorePlan',
        maxTurns: 1,
        model,
        effort,
    });
}

/**
 * Ask whether the repaired file is better than the one it would replace.
 *
 * Anything but a clean "better" keeps the original: a repair that redrew the lettering is worse
 * for measurement than the defect it removed, and the measurer cannot tell the two apart.
 * @param {{ roles: object, before: string, after: string, root: string, model: string|null,
 *   effort: string|null }} params
 * @returns {Promise<{ verdict: string, reason: string }>}
 * @ai.hint io
 */
async function verifyRepair({ roles, before, after, root, model, effort }) {
    const [first, second] = await Promise.all([readFile(before), readFile(after)]);
    const resolved = roles.resolve?.('restorerVerify');
    const result = await roles.run('restorerVerify', {
        text: 'BEFORE is the first image, AFTER is the second. Which should the measurer use?',
        parts: [imagePart(first, sniffImage(first).mime), imagePart(second, sniffImage(second).mime)],
        instructions: resolved?.instructions ?? ROLE_INSTRUCTIONS.restorerVerify,
        schema: RESTORE_VERIFY_SCHEMA,
        schemaName: 'restoreVerdict',
        maxTurns: 1,
        model,
        effort,
    });
    if (!result?.data?.verdict) {
        return { verdict: 'worse', reason: `the verification did not answer (${result?.status ?? 'unknown'})` };
    }
    return { verdict: result.data.verdict, reason: String(result.data.reason ?? '').trim() };
}

/**
 * The geometry the role asked for, inside the limits of the configuration.
 *
 * The role only names the numbers: the harness turns them into a rotation and a size correction.
 * A number above the limit is refused rather than rounded down — a screen that is tilted by twenty
 * degrees is not a screen that is tilted by six, and quietly cutting the correction in half would
 * hide a mistake the user has to see.
 * @param {object} raw the `geometry` object of the role's answer
 * @param {{ maxRotateDeg: number, maxScalePercent: number }} limits
 * @returns {{ rotateDeg: number|null, scalePercent: number|null, reason: string, refused: string[] }}
 * @ai.hint pure
 */
function readGeometry(raw, limits) {
    const rotateDeg = Number(raw?.rotateDeg);
    const scalePercent = Number(raw?.scalePercent);
    const result = { rotateDeg: null, scalePercent: null, reason: String(raw?.reason ?? '').trim(), refused: [] };
    if (Number.isFinite(rotateDeg) && Math.abs(rotateDeg) > 0.05) {
        if (Math.abs(rotateDeg) > limits.maxRotateDeg) {
            result.refused.push(`the tilt of ${rotateDeg}° is above the limit of ${limits.maxRotateDeg}°`);
        } else {
            result.rotateDeg = rotateDeg;
        }
    }
    if (Number.isFinite(scalePercent) && Math.abs(scalePercent) > 0.05) {
        if (Math.abs(scalePercent) > limits.maxScalePercent) {
            result.refused.push(`the size correction of ${scalePercent}% is above the limit of ${limits.maxScalePercent}%`);
        } else {
            result.scalePercent = scalePercent;
        }
    }
    return result;
}

/**
 * Run the reconstruct stage.
 *
 * Nothing here overwrites an input: each repaired screen is a new file under `restored/`. A screen
 * whose patches all failed keeps its original and is reported, so the measurer still gets a screen.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function runReconstruct(state, notify = () => {}) {
    const { root, workDir, config, client, roles, model, effort, imageModel, warnings } = state;
    const files = inputFiles(state, root);
    if (!files.length) {
        warnings.push('reconstruct: no screens to restore');
        return;
    }
    if (!client?.images) {
        warnings.push('reconstruct: images API unavailable, skipping');
        return;
    }
    const editorModel = imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) {
        warnings.push('reconstruct: no image model for the editor, skipping');
        return;
    }

    const settings = config.stages?.reconstruct ?? {};
    const engine = config.raster?.engine ?? 'auto';
    const maxAttempts = Number.isSafeInteger(settings.maxAttempts) ? Math.max(1, settings.maxAttempts) : 2;
    const boxPadding = Number.isSafeInteger(settings.boxPadding) ? Math.max(0, settings.boxPadding) : FRAGMENT_MARGIN;
    const maxPatches = Number.isSafeInteger(settings.maxPatches) ? Math.max(1, settings.maxPatches) : 3;
    const geometrySettings = settings.geometry ?? defaults.stages.reconstruct.geometry;
    const geometryLimits = {
        enabled: geometrySettings.enabled !== false,
        maxRotateDeg: Number.isFinite(geometrySettings.maxRotateDeg) ? geometrySettings.maxRotateDeg : 6,
        maxScalePercent: Number.isFinite(geometrySettings.maxScalePercent) ? geometrySettings.maxScalePercent : 10,
        minImprovementDeg: Number.isFinite(geometrySettings.minImprovementDeg) ? geometrySettings.minImprovementDeg : 0.2,
    };

    const outDir = path.join(root, workDir, RESTORED_DIR);
    await mkdir(outDir, { recursive: true });
    const scratch = path.join(root, workDir, '.restore');

    const replaced = [];
    const kept = [];
    const usedNames = new Set();

    for (const file of files) {
        const frame = await rasterInfo(file.abs, { cwd: root, engine }).catch(() => null);
        if (!frame?.width || !frame?.height) {
            warnings.push(`reconstruct: cannot read ${file.rel}`);
            kept.push({ from: file.rel, kept: true, reason: 'the file cannot be read' });
            continue;
        }

        const original = await sourcePart(root, file.source);
        const plan = await askRestorer({ roles, file, frame, original, model, effort });
        if (!plan?.data) {
            warnings.push(`reconstruct: ${file.rel}: the restoration plan was not read `
                + `(${plan?.error ?? plan?.status ?? 'unknown'}); the file stays as it is`);
            kept.push({ from: file.rel, kept: true, reason: 'the restorer did not answer' });
            continue;
        }
        const geometry = readGeometry(plan.data.geometry, geometryLimits);
        for (const refusal of geometry.refused) {
            warnings.push(`reconstruct: ${file.rel}: ${refusal}`);
        }
        const wanted = Array.isArray(plan.data.patches) ? plan.data.patches : [];
        const wantsGeometry = geometry.rotateDeg != null || geometry.scalePercent != null;
        if (!wanted.length && !wantsGeometry) {
            kept.push({ from: file.rel, kept: true, reason: 'the screen is clean' });
            continue;
        }

        const accepted = pickPatches(wanted, {
            frameWidth: frame.width,
            frameHeight: frame.height,
            maxPatches,
        });
        for (const rejected of accepted.rejected) {
            warnings.push(`reconstruct: ${file.rel}: the patch `
                + `(${rejected.patch.x},${rejected.patch.y}) ${rejected.patch.width}×${rejected.patch.height} `
                + `was refused — ${rejected.reason}`);
        }
        if (!accepted.patches.length && !wantsGeometry) {
            kept.push({ from: file.rel, kept: true, reason: 'every patch was refused' });
            continue;
        }

        notify({
            type: 'reconstruct.start',
            file: file.rel,
            patches: accepted.patches.length,
            assessment: plan.data.assessment ?? '',
            model: editorModel,
        });

        await mkdir(scratch, { recursive: true }).catch(() => {});
        try {
            // Each patch is applied to the result of the previous one, so the last merge is the file
            // that replaces the screen.
            let currentAbs = file.abs;
            let applied = [];
            for (const [index, patch] of accepted.patches.entries()) {
                const box = planFragment(patch, {
                    frameWidth: frame.width,
                    frameHeight: frame.height,
                    margin: boxPadding,
                });
                const fragmentAbs = path.join(scratch, `${index + 1}-fragment.png`);
                const editedAbs = path.join(scratch, `${index + 1}-edited.png`);
                const mergedAbs = path.join(scratch, `${index + 1}-merged.png`);
                try {
                    await rasterCrop({
                        input: currentAbs,
                        output: fragmentAbs,
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        cwd: root,
                        engine,
                    });
                    const fragment = await readFile(fragmentAbs);
                    const edited = await editFragment({
                        client,
                        editorModel,
                        prompt: editorPrompt(patch.prompt),
                        filename: path.basename(fragmentAbs),
                        bytes: fragment,
                        maxAttempts,
                    });
                    if (!edited) {
                        warnings.push(`reconstruct: ${file.rel}: region ${index + 1} was not repaired`);
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
                    applied.push({
                        kind: patch.kind,
                        box: merged.box,
                        finding: patch.finding,
                        prompt: patch.prompt,
                        resized: merged.resized,
                        grown: box.grown,
                    });
                    currentAbs = mergedAbs;
                } catch (error) {
                    warnings.push(`reconstruct: ${file.rel}: region ${index + 1} was not repaired (${error?.message ?? error})`);
                } finally {
                    await unlink(fragmentAbs).catch(() => {});
                    await unlink(editedAbs).catch(() => {});
                    if (currentAbs !== mergedAbs) await unlink(mergedAbs).catch(() => {});
                }
            }

            // The pixels are checked before the geometry is applied: a rotation moves every element
            // of the screen, and the verifier would call that a change it has to refuse.
            let baseAbs = file.abs;
            let verification = null;
            if (applied.length) {
                baseAbs = currentAbs;
                verification = await verifyRepair({
                    roles,
                    before: file.abs,
                    after: baseAbs,
                    root,
                    model,
                    effort,
                }).catch((error) => ({ verdict: 'worse', reason: error?.message ?? String(error) }));
                if (verification.verdict !== 'better') {
                    warnings.push(`reconstruct: ${file.rel}: the repair was refused by the verification `
                        + `(${verification.verdict}: ${verification.reason}) — the original screen stays`);
                    applied = [];
                    baseAbs = file.abs;
                }
            }

            // The geometry is applied to the pixels that survived, and it is judged by the
            // measurement: the correction is kept when the screen became flatter, and rolled back
            // when it did not.
            let geometryResult = null;
            if (wantsGeometry) {
                if (!geometryLimits.enabled) {
                    warnings.push(`reconstruct: ${file.rel}: the geometry correction is switched off`);
                } else {
                    const geometryAbs = path.join(scratch, 'geometry.png');
                    try {
                        const geo = await applyGeometry({
                            input: baseAbs,
                            output: geometryAbs,
                            rotateDeg: geometry.rotateDeg ?? 0,
                            scalePercent: geometry.scalePercent ?? 0,
                            cwd: root,
                            engine,
                        });
                        const before = Math.abs(geo.residualBefore.angleDeg ?? 0);
                        const after = Math.abs(geo.residualAfter.angleDeg ?? 0);
                        const measured = geo.residualAfter.measured === true;
                        const worse = geometry.rotateDeg != null && measured
                            && !(after < before - geometryLimits.minImprovementDeg);
                        if (worse) {
                            warnings.push(`reconstruct: ${file.rel}: the geometry correction was rolled back — `
                                + `the tilt went from ${before}° to ${after}°`);
                            notify({
                                type: 'reconstruct.geometry',
                                file: file.rel,
                                status: 'rolled back',
                                rotateDeg: geometry.rotateDeg ?? 0,
                                scalePercent: geometry.scalePercent ?? 0,
                                before,
                                after,
                            });
                        } else {
                            geometryResult = geo;
                            baseAbs = geometryAbs;
                            notify({
                                type: 'reconstruct.geometry',
                                file: file.rel,
                                status: 'applied',
                                rotateDeg: geometry.rotateDeg ?? 0,
                                scalePercent: geometry.scalePercent ?? 0,
                                before,
                                after,
                            });
                        }
                    } catch (error) {
                        warnings.push(`reconstruct: ${file.rel}: the geometry correction failed (${error?.message ?? error})`);
                    }
                }
            }

            if (baseAbs === file.abs) {
                kept.push({ from: file.rel, kept: true, reason: applied.length ? 'the screen stays as it is' : 'nothing was changed' });
                notify({
                    type: 'reconstruct.done', file: file.rel, status: applied.length ? 'rejected' : 'failed',
                    patches: applied.length, verdict: verification?.verdict ?? null,
                });
                continue;
            }

            const name = uniqueName(path.basename(file.rel), usedNames);
            const to = toPosix(path.join(workDir, RESTORED_DIR, name));
            const target = path.join(root, ...to.split('/'));
            try {
                await mkdir(path.dirname(target), { recursive: true });
                await copyFile(baseAbs, target);
            } catch (error) {
                warnings.push(`reconstruct: ${file.rel}: the repaired file was not saved (${error?.message ?? error})`);
                kept.push({ from: file.rel, kept: true, reason: 'the result was not saved' });
                notify({ type: 'reconstruct.done', file: file.rel, status: 'failed', patches: applied.length });
                continue;
            }

            const saved = await stat(target).catch(() => null);
            replaced.push({ from: file.rel, to, patches: applied, geometry: geometryResult, verification, bytes: saved?.size ?? 0 });
            notify({
                type: 'reconstruct.done',
                file: file.rel,
                status: 'repaired',
                to,
                patches: applied.length,
                verdict: verification?.verdict ?? null,
            });
        } finally {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
    }

    state.restored.push(...replaced, ...kept);

    // The repaired files replace their sources in the screens and in the reference list.
    const byFrom = new Map(replaced.map((item) => [item.from, item]));
    if (byFrom.size && Array.isArray(state.screens)) {
        state.screens = state.screens.map((screen) => {
            const item = byFrom.get(screen.subReference);
            if (!item) return screen;
            const kind = item.patches.length ? 'repaired' : 'restored';
            return { ...screen, subReference: item.to, subReferenceKind: kind };
        });
    }
    if (byFrom.size && Array.isArray(state.screensFiles) && state.screensFiles.length) {
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
    if (byFrom.size && state.images?.length) {
        state.images = state.images.map((rel) => byFrom.get(toPosix(rel))?.to ?? rel);
    }
}

/**
 * Send one fragment to the image editor and wait for an answer.
 * @param {{ client: object, editorModel: string, prompt: string, filename: string, bytes: Buffer,
 *   maxAttempts: number }} params
 * @returns {Promise<Buffer|null>} the edited bytes, or null when the editor did not answer
 * @ai.hint io
 */
async function editFragment({ client, editorModel, prompt, filename, bytes, maxAttempts }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const answer = await client.images.edit({
                model: editorModel,
                prompt,
                format: 'png',
                image: { filename, mime: sniffImage(bytes).mime, bytes },
            });
            if (!answer?.images?.length) throw new Error('the editor returned an empty answer');
            return answer.images[0].bytes;
        } catch (error) {
            if (attempt >= maxAttempts) return null;
        }
    }
    return null;
}

/**
 * A file name that is not taken yet: the name of the screen, with a counter when two screens carry
 * the same name.
 * @param {string} name the name of the screen file
 * @param {Set<string>} used the names that are taken
 * @returns {string}
 * @ai.hint pure
 */
function uniqueName(name, used) {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    const parsed = path.parse(name);
    let index = 2;
    let candidate = `${parsed.name}-${index}${parsed.ext}`;
    while (used.has(candidate)) {
        index += 1;
        candidate = `${parsed.name}-${index}${parsed.ext}`;
    }
    used.add(candidate);
    return candidate;
}
