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
 * @depends node:path, node:fs/promises, agent/schemas, agent/paths, image/raster, openai/images,
 *   openai/responses, roles/index, stages/restore-plan
 * @usedBy shared/pipeline
 * @exports runReconstruct, RESTORED_DIR
 * @ai.tags restoration, screens, fragments
 * @ai.hint keep
 */

import path from 'node:path';
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { rasterCrop, rasterInfo, rasterPatch } from '../image/raster.js';
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
        if (plan.data.verdict !== 'repair' || !(plan.data.patches ?? []).length) {
            kept.push({ from: file.rel, kept: true, reason: 'the screen is clean' });
            continue;
        }

        const accepted = pickPatches(plan.data.patches, {
            frameWidth: frame.width,
            frameHeight: frame.height,
            maxPatches,
        });
        for (const rejected of accepted.rejected) {
            warnings.push(`reconstruct: ${file.rel}: the patch `
                + `(${rejected.patch.x},${rejected.patch.y}) ${rejected.patch.width}×${rejected.patch.height} `
                + `was refused — ${rejected.reason}`);
        }
        if (!accepted.patches.length) {
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

        // Each patch is applied to the result of the previous one, so the last merge is the file
        // that replaces the screen.
        let currentAbs = file.abs;
        const applied = [];
        await mkdir(scratch, { recursive: true }).catch(() => {});
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

        if (!applied.length) {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
            kept.push({ from: file.rel, kept: true, reason: 'no region was repaired' });
            notify({ type: 'reconstruct.done', file: file.rel, status: 'failed', patches: 0 });
            continue;
        }

        const name = uniqueName(path.basename(file.rel), usedNames);
        const to = toPosix(path.join(workDir, RESTORED_DIR, name));
        const target = path.join(root, ...to.split('/'));
        try {
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(currentAbs, target);
        } catch (error) {
            warnings.push(`reconstruct: ${file.rel}: the repaired file was not saved (${error?.message ?? error})`);
            kept.push({ from: file.rel, kept: true, reason: 'the result was not saved' });
            continue;
        } finally {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }

        const verification = await verifyRepair({
            roles,
            before: file.abs,
            after: target,
            root,
            model,
            effort,
        }).catch((error) => ({ verdict: 'worse', reason: error?.message ?? String(error) }));
        if (verification.verdict !== 'better') {
            warnings.push(`reconstruct: ${file.rel}: the repair was refused by the verification `
                + `(${verification.verdict}: ${verification.reason}) — the original screen stays`);
            await unlink(target).catch(() => {});
            kept.push({ from: file.rel, kept: true, reason: `verdict ${verification.verdict}` });
            notify({
                type: 'reconstruct.done', file: file.rel, status: 'rejected',
                patches: applied.length, verdict: verification.verdict,
            });
            continue;
        }

        const saved = await stat(target).catch(() => null);
        replaced.push({ from: file.rel, to, patches: applied, verification, bytes: saved?.size ?? 0 });
        notify({
            type: 'reconstruct.done',
            file: file.rel,
            status: 'repaired',
            to,
            patches: applied.length,
            verdict: verification.verdict,
        });
    }

    state.restored.push(...replaced, ...kept);

    // The repaired files replace their sources in the screens and in the reference list.
    const byFrom = new Map(replaced.map((item) => [item.from, item]));
    if (byFrom.size && Array.isArray(state.screens)) {
        state.screens = state.screens.map((screen) => {
            const item = byFrom.get(screen.subReference);
            if (!item) return screen;
            return { ...screen, subReference: item.to, subReferenceKind: 'repaired' };
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
