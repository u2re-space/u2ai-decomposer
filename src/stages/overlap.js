/**
 * @file src/stages/overlap.js
 * @module stages/overlap
 * @purpose Stage 4: remove the content that belongs to another screen.
 *
 *   A collage cut into screens leaves pieces of its neighbours behind: a navigation bar that
 *   spanned the whole picture, a device bezel that belongs to the frame and not to the screen, a
 *   wallpaper that bleeds over the boundary. The measurer would read those pixels as part of the
 *   screen, so they have to go.
 *
 *   The comparison is the role's job — it looks at the screens side by side and names the foreign
 *   regions. The removal is the harness's job, and it is the same contract as in the reconstruct
 *   stage: the region is cut out, the editor sees only that fragment, and the answer is stitched
 *   back into exactly that box. Everything outside the box stays as it was.
 *
 * @depends node:path, node:fs/promises, agent/schemas, agent/tool-specs, image/raster,
 *   openai/images, openai/responses, roles/index, stages/restore-plan
 * @usedBy shared/pipeline
 * @exports runOverlap, OVERLAP_DIR, OVERLAP_TOOLS
 * @ai.tags overlap, screens, fragments
 * @ai.hint keep
 */

import path from 'node:path';
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { OVERLAP_DEFECT_KINDS, OVERLAP_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { toPosix } from '../agent/paths.js';
import { toolSpecs } from '../agent/tool-specs.js';
import { rasterCrop, rasterInfo, rasterPatch } from '../image/raster.js';
import { imageModelFor, sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';
import { editorPrompt, pickPatches, planFragment } from './restore-plan.js';

/** Directory under the work directory where the cleaned copies are written. */
export const OVERLAP_DIR = 'overlap';

/** The tools the overlap role may call: it looks, it compares, it names. */
export const OVERLAP_TOOLS = ['view_image', 'compare_images'];

/**
 * The screens the stage works on: the files the reconstruct stage produced, or the images of the
 * state when the stage runs on its own.
 * @param {object} state pipeline state
 * @param {string} root project root
 * @returns {Array<{ rel: string, abs: string, screen: string }>}
 * @ai.hint pure
 */
function inputFiles(state, root) {
    const list = Array.isArray(state.screensFiles) && state.screensFiles.length
        ? state.screensFiles
        : (state.images ?? []).map((rel) => ({ rel }));
    return list.map((file) => ({
        rel: toPosix(file.rel),
        abs: file.abs ?? path.resolve(root, file.rel),
        screen: file.screen ?? path.basename(toPosix(file.rel), path.extname(toPosix(file.rel))),
    }));
}

/**
 * Find the screen a patch belongs to.
 *
 * The role may name a screen by its name, by its file name or by its path; all three are tried.
 * @param {Array<{ rel: string, screen: string }>} files the screens of the run
 * @param {string} name the name the role used
 * @returns {object|null}
 * @ai.hint pure
 */
function screenOf(files, name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    for (const file of files) {
        const stem = path.basename(file.rel, path.extname(file.rel));
        if ([file.screen, stem, file.rel].filter(Boolean).some((value) => value.toLowerCase() === wanted)) {
            return file;
        }
    }
    return null;
}

/**
 * Run the overlap stage.
 *
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function runOverlap(state, notify = () => {}) {
    const { root, workDir, config, client, roles, model, effort, imageModel, warnings, toolset } = state;
    const files = inputFiles(state, root);
    if (files.length < 2) {
        warnings.push('overlap: less than two screens, nothing to compare');
        return;
    }
    if (!client?.images) {
        warnings.push('overlap: images API unavailable, skipping');
        return;
    }
    const editorModel = imageModel || imageModelFor(config, { hasImage: true });
    if (!editorModel) {
        warnings.push('overlap: no image model for the editor, skipping');
        return;
    }

    const settings = config.stages?.overlap ?? {};
    const engine = config.raster?.engine ?? 'auto';
    const maxAttempts = Number.isSafeInteger(settings.maxAttempts) ? Math.max(1, settings.maxAttempts) : 2;
    const boxPadding = Number.isSafeInteger(settings.boxPadding) ? Math.max(0, settings.boxPadding) : 16;
    const maxPatches = Number.isSafeInteger(settings.maxPatches) ? Math.max(1, settings.maxPatches) : 3;

    const outDir = path.join(root, workDir, OVERLAP_DIR);
    await mkdir(outDir, { recursive: true });
    const scratch = path.join(root, workDir, '.overlap');

    const extraTools = toolset?.specsFor
        ? toolset.specsFor('overlap', OVERLAP_TOOLS)
        : toolSpecs(config.tools ?? {}, {
            role: 'overlap',
            names: OVERLAP_TOOLS,
            imageApi: Boolean(state.client?.images),
        });

    // The role compares the screens side by side, so it gets all of them at once.
    const parts = [];
    const listing = [];
    for (const file of files) {
        const bytes = await readFile(file.abs).catch(() => null);
        if (!bytes) continue;
        const frame = await rasterInfo(file.abs, { cwd: root, engine }).catch(() => null);
        parts.push(imagePart(bytes, sniffImage(bytes).mime));
        listing.push(`${listing.length + 1}. ${file.screen || path.basename(file.rel)} — ${file.rel}`
            + `${frame?.width ? ` (${frame.width}×${frame.height})` : ''}`);
    }
    if (!parts.length) {
        warnings.push('overlap: no readable screen to compare');
        return;
    }

    const resolved = roles.resolve?.('overlap');
    const plan = await roles.run('overlap', {
        text: [
            'Screens to compare:',
            ...listing,
            '',
            'Compare them and name the regions that belong to another screen.',
        ].join('\n'),
        parts,
        instructions: resolved?.instructions ?? ROLE_INSTRUCTIONS.overlap,
        schema: OVERLAP_SCHEMA,
        schemaName: 'overlapPlan',
        maxTurns: 1,
        extraTools,
        model,
        effort,
    });

    if (!plan?.data || plan.data.verdict === 'clean' || !(plan.data.patches ?? []).length) {
        state.overlapResolved.push(...files.map((file) => ({ from: file.rel, to: file.rel, kept: true })));
        notify({ type: 'overlap.done', count: 0 });
        return;
    }

    // Every patch is validated against the screen it claims to belong to.
    const byScreen = new Map();
    for (const raw of plan.data.patches) {
        const file = screenOf(files, raw?.screen);
        if (!file) {
            warnings.push(`overlap: the screen "${String(raw?.screen ?? '').trim()}" is not one of the screens of this run`);
            continue;
        }
        if (!byScreen.has(file.rel)) byScreen.set(file.rel, { file, patches: [] });
        byScreen.get(file.rel).patches.push(raw);
    }

    const resolvedFiles = [];
    const usedNames = new Set();
    for (const [rel, group] of byScreen) {
        const frame = await rasterInfo(group.file.abs, { cwd: root, engine }).catch(() => null);
        if (!frame?.width) {
            resolvedFiles.push({ from: rel, to: rel, kept: true });
            continue;
        }
        const accepted = pickPatches(group.patches, {
            frameWidth: frame.width,
            frameHeight: frame.height,
            maxPatches,
            kinds: OVERLAP_DEFECT_KINDS,
        });
        for (const rejected of accepted.rejected) {
            warnings.push(`overlap: ${rel}: the region `
                + `(${rejected.patch.x},${rejected.patch.y}) ${rejected.patch.width}×${rejected.patch.height} `
                + `was refused — ${rejected.reason}`);
        }
        const patches = accepted.patches;
        if (!patches.length) {
            resolvedFiles.push({ from: rel, to: rel, kept: true });
            continue;
        }
        let currentAbs = group.file.abs;
        const applied = [];
        await mkdir(scratch, { recursive: true }).catch(() => {});
        for (const [index, patch] of patches.entries()) {
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
                    warnings.push(`overlap: ${rel}: region ${index + 1} was not cleaned`);
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
                warnings.push(`overlap: ${rel}: region ${index + 1} was not cleaned (${error?.message ?? error})`);
            } finally {
                await unlink(fragmentAbs).catch(() => {});
                await unlink(editedAbs).catch(() => {});
                if (currentAbs !== mergedAbs) await unlink(mergedAbs).catch(() => {});
            }
        }
        if (!applied.length) {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
            resolvedFiles.push({ from: rel, to: rel, kept: true });
            continue;
        }

        const name = uniqueName(path.basename(rel), usedNames);
        const to = toPosix(path.join(workDir, OVERLAP_DIR, name));
        const target = path.join(root, ...to.split('/'));
        try {
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(currentAbs, target);
        } catch (error) {
            warnings.push(`overlap: ${rel}: the cleaned file was not saved (${error?.message ?? error})`);
            resolvedFiles.push({ from: rel, to: rel, kept: true });
            continue;
        } finally {
            await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }

        const saved = await stat(target).catch(() => null);
        resolvedFiles.push({ from: rel, to, patches: applied, bytes: saved?.size ?? 0 });
        notify({ type: 'overlap.file', file: to, from: rel, patches: applied.length });
    }

    // The screens that were not touched keep their file.
    for (const file of files) {
        if (!resolvedFiles.some((item) => item.from === file.rel)) {
            resolvedFiles.push({ from: file.rel, to: file.rel, kept: true });
        }
    }
    state.overlapResolved.push(...resolvedFiles);

    const byFrom = new Map(resolvedFiles.map((item) => [item.from, item]));
    if (Array.isArray(state.screens)) {
        state.screens = state.screens.map((screen) => {
            const item = byFrom.get(screen.subReference);
            if (!item || item.kept) return screen;
            return { ...screen, subReference: item.to, subReferenceKind: 'repaired' };
        });
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
    if (state.images?.length) {
        state.images = state.images.map((rel) => byFrom.get(toPosix(rel))?.to ?? rel);
    }

    notify({ type: 'overlap.done', count: resolvedFiles.filter((item) => !item.kept).length });
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
