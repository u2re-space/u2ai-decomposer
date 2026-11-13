/**
 * @file src/stages/decompose.js
 * @module stages/decompose
 * @purpose Stage 1: split the reference into screens, one clean sub-reference per screen.
 * @depends node:path, node:fs/promises, image/sizing, agent/decomposition, agent/schemas,
 *   stages/decompose-screens
 * @exports runDecompose, AGENT_TOOLS, INLINE_TOOLS
 * @ai.tags decomposition, screens
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DECOMPOSER_INLINE_SCHEMA, DECOMPOSER_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { collectSubReferences, decompositionReport, SCREENS_DIR } from '../agent/decomposition.js';
import { downscaleToMaxSide } from '../image/sizing.js';
import { toolSpecs } from '../agent/tool-specs.js';
import { imagePart } from '../openai/responses.js';
import { sniffImage } from '../openai/images.js';
import { toPosix } from '../agent/paths.js';
import { cropScreens, planScreens } from './decompose-screens.js';

/** The tools the decomposer may call when it writes the screens itself. */
export const AGENT_TOOLS = ['view_image', 'crop_image', 'split_image', 'compare_images', 'correct_perspective'];

/** The tools the decomposer may call when the harness cuts the screens. */
export const INLINE_TOOLS = ['view_image'];

/**
 * Run the decompose stage.
 *
 * Two modes. In agent mode the role writes the screens itself with the image tools; in inline
 * mode it only names the rectangle of every screen and the harness cuts those pixels. Both end
 * with the same state: the screens, the files they point at, and the decomposition object.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 */
export async function runDecompose(state, notify = () => {}) {
    const { root, images, workDir, config, roles, model, effort, warnings, toolset } = state;
    if (!images?.length) {
        warnings.push('decompose: no images to process');
        return;
    }

    const settings = config.stages?.decompose ?? {};
    const mode = settings.mode === 'inline' ? 'inline' : 'agent';
    const engine = config.raster?.engine ?? 'auto';
    const workRoot = path.resolve(root, workDir);
    const screensDir = path.join(workRoot, SCREENS_DIR);
    const screensRel = toPosix(path.relative(root, screensDir));
    await mkdir(screensDir, { recursive: true });
    toolset?.setWriteDirs?.([screensDir]);

    // The picture the model sees may be a smaller copy of the source; the rects it answers with
    // belong to that copy, so both frames are remembered.
    const parts = [];
    const sources = [];
    for (const img of images) {
        const absolute = path.resolve(root, img);
        let bytes;
        try {
            bytes = await readFile(absolute);
        } catch {
            warnings.push(`decompose: cannot read ${img}`);
            continue;
        }
        let copy;
        try {
            copy = await downscaleToMaxSide(bytes, {
                maxSide: config.image?.maxSide ?? null,
                maxMegapixels: config.image?.maxMegapixels ?? null,
                engine,
            });
        } catch (error) {
            warnings.push(`decompose: ${img} was not sent to the model (${error?.message ?? error})`);
            continue;
        }
        sources.push({
            rel: toPosix(path.relative(root, absolute)),
            abs: absolute,
            original: { width: copy.originalWidth, height: copy.originalHeight },
            model: { width: copy.width, height: copy.height },
        });
        parts.push(imagePart(copy.bytes, sniffImage(copy.bytes).mime));
    }
    if (!sources.length) {
        warnings.push('decompose: no readable reference');
        return;
    }

    const toolNames = mode === 'inline'
        ? INLINE_TOOLS
        : [...AGENT_TOOLS, ...(config.tools?.image_generate !== false && state.client?.images ? ['generate_image', 'edit_image'] : [])];
    const extraTools = toolset?.specsFor
        ? toolset.specsFor('decomposer', toolNames)
        : toolSpecs(config.tools ?? {}, {
            role: 'decomposer',
            names: toolNames,
            imageApi: Boolean(state.client?.images),
        });

    const brief = mode === 'inline'
        ? `Inline mode: do not write any file. Return the rectangle of every screen in the attached picture
(x, y, width, height in the pixels of that picture). The harness cuts the pixels itself, so a screen you
cannot cut has no rectangle and stays a name only.`
        : `Output directory: ${screensRel}/ — the only place you may write.
Name the files by their order: 01-home.png, 02-checkout.png.
Never list a file you did not actually create.
For a rectified or regenerated view, run compare_images against the source.`;

    const resolved = roles.resolve?.('decomposer');
    const instructions = [resolved?.instructions ?? ROLE_INSTRUCTIONS.decomposer, brief].join('\n\n');

    const result = await roles.run('decomposer', {
        text: mode === 'inline'
            ? `Reference: ${sources.map((source) => source.rel).join(', ')}\nReturn the rectangle of every screen.`
            : `References: ${sources.map((source) => source.rel).join(', ')}\nOutput directory: ${screensRel}/\n`
                + 'Split these references into distinct screens and produce one clean sub-reference image for each.',
        parts,
        instructions,
        schema: mode === 'inline' ? DECOMPOSER_INLINE_SCHEMA : DECOMPOSER_SCHEMA,
        schemaName: 'decomposition',
        maxTurns: mode === 'inline'
            ? 2
            : (Number.isSafeInteger(settings.maxTurns) ? settings.maxTurns : 32),
        model,
        effort,
        extraTools,
    });

    if (!result?.data) {
        warnings.push(`decompose: role returned no data (${result?.status ?? 'unknown'})`);
        state.decomposition = null;
        state.screens = [];
        state.screensFiles = [];
        return;
    }

    let files = [];
    let collectedWarnings = [];
    if (mode === 'inline') {
        const source = sources[0];
        if (sources.length > 1) warnings.push('decompose: inline mode cuts the first reference only');
        const planned = planScreens({
            decomposition: result.data,
            frame: source.model,
            source: source.original,
            limits: settings,
        });
        for (const drop of planned.dropped) {
            collectedWarnings.push(`decompose: screen ${drop.name} was not cut (${drop.reason})`);
        }
        const cut = await cropScreens({
            root,
            screensDir,
            source: source.abs,
            accepted: planned.accepted,
            engine,
        });
        files = cut.files;
        collectedWarnings.push(...cut.warnings);
    } else {
        const collected = await collectSubReferences({
            root,
            workDir,
            decomposition: result.data,
            maxBytes: config.limits?.maxImageBytes ?? null,
            maxFiles: Number.isSafeInteger(settings.maxSubReferences) ? settings.maxSubReferences : 12,
        });
        files = collected.files;
        collectedWarnings = collected.warnings;
    }
    warnings.push(...collectedWarnings);

    // Every screen points at a file that exists; a screen without one stays a name.
    const byScreen = new Map(files.map((file) => [file.screen, file]));
    const screens = (result.data.screens ?? []).map((screen) => {
        const file = byScreen.get(String(screen?.name ?? '').trim());
        if (!file) return { ...screen, subReference: null, subReferenceKind: '' };
        return { ...screen, subReference: file.rel, subReferenceKind: file.kind || 'crop' };
    });
    const subReferences = files.map((file) => ({
        path: file.rel,
        screen: file.screen,
        kind: file.kind || 'crop',
        source: file.source ?? '',
        note: file.note ?? '',
    }));
    const decomposition = { ...result.data, screens, subReferences };

    state.decomposition = decomposition;
    state.screens = screens;
    state.screensFiles = files;
    if (files.length) state.images = files.map((file) => file.rel);

    const jsonPath = path.join(workRoot, 'decompose.json');
    await writeFile(jsonPath, JSON.stringify(decomposition, null, 2));

    notify({ type: 'decompose.screens', screens: screens.length, files: files.length });
    notify({ type: 'decompose.done', screens: screens.length, files: files.length });
    notify({ type: 'decompose.report', report: decompositionReport(decomposition, files, toPosix(path.relative(root, workRoot))) });
}
