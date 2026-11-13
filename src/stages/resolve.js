/**
 * @file src/stages/resolve.js
 * @module stages/resolve
 * @purpose Stage 5: assemble the final decomposition.json out of everything the earlier stages
 *          produced, and — in advanced mode — split one screen into layers.
 *
 *   The stages form a chain. The decompose stage cuts the screens, rectify may project them,
 *   reconstruct may repair a fragment of one, overlap may clean a foreign region out of one.
 *   Each stage writes a new file and remembers what it replaced, so the final answer is not the
 *   first file but the last one in the chain — and the file it points at has to exist, because a
 *   decomposition that names a picture nobody can open is not a decomposition.
 *
 *   The layer split is the advanced part, and it has two sources:
 *     - `seedream`: the image model splits the screen itself and answers with a base picture and
 *       transparent PNG layers, each with a bounding box in the coordinates of the base. The file
 *       of a layer is scaled on its own by the model, so it is brought to `w × h` of its box before
 *       it is written — the pixels of the file are not the coordinates of the base;
 *     - `director`: the text role names the layers with a box and the harness cuts those boxes out
 *       of the pixels of the screen.
 *
 *   The model never draws a layer in the second case: it only says where it is, and the pixels of
 *   the layer are the pixels of the screen.
 *
 * @depends node:path, node:fs/promises, agent/schemas, agent/paths, agent/tool-specs,
 *   image/raster, image/sizing, openai/images, openai/responses, openai/seedream, roles/index
 * @usedBy shared/pipeline
 * @exports runResolve, LAYERS_DIR, DECOMPOSITION_FILE, DIRECTOR_TOOLS, resolveLayerSource
 * @ai.tags decomposition, output, layers
 * @ai.hint keep
 */

import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { LAYERS_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { resolveInside, toPosix } from '../agent/paths.js';
import { toolSpecs } from '../agent/tool-specs.js';
import { rasterCrop, rasterFitToBox, rasterInfo } from '../image/raster.js';
import { downscaleToMaxSide } from '../image/sizing.js';
import { sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';
import {
    SEEDREAM_INPUT_MAX_BYTES, SEEDREAM_INPUT_MAX_PIXELS, SEEDREAM_MODEL, decomposeLayers,
    downloadImageBytes, isSeedream55, parseLayerDecomposition,
} from '../openai/seedream.js';

/** Directory of the layer files, next to the decomposition JSON. */
export const LAYERS_DIR = 'layers';

/** The name of the final file. */
export const DECOMPOSITION_FILE = 'decomposition.json';

/** The tools the director may call while it splits a screen into layers. */
export const DIRECTOR_TOOLS = ['view_image'];

/**
 * The wording that asks the image model for tight boxes.
 *
 * The vendor scales every layer on its own, so the box of a layer is the only thing that decides
 * the size of the layer file: a square box around a wide object buys back exactly the padding the
 * split was made to remove. The canvas cannot be asked for (the model scales each layer
 * independently), but the box is a number the model writes, so it can.
 */
const TIGHT_BOX_PROMPT = 'Report each bounding_box as the tightest rectangle that fully contains the visible pixels of that layer, '
    + 'with no margin, no padding and no allowance for shadow. Do not round a box to a square and do not widen or heighten it to a '
    + 'convenient size: a wide element gets a wide box, a tall element a tall box, and each box keeps the aspect ratio of what it frames. '
    + 'Keep every box inside the frame of the source image.';


/**
 * The chain of the files: what replaced what.
 *
 * Every stage that writes a new file remembers the file it replaced, so the chain is a map from a
 * path to the path that took its place. A stage that kept the original maps a path onto itself,
 * which is where the walk stops.
 * @param {object} state pipeline state
 * @returns {Map<string, { to: string, kind: string, stage: string }>}
 * @ai.hint pure
 */
export function buildChain(state) {
    const chain = new Map();
    const stages = [
        { stage: 'rectify', list: state?.rectified, kind: 'restored' },
        { stage: 'reconstruct', list: state?.restored, kind: 'repaired' },
        { stage: 'overlap', list: state?.overlapResolved, kind: 'repaired' },
    ];
    for (const { stage, list, kind } of stages) {
        for (const entry of list ?? []) {
            const from = toPosix(entry?.from ?? '');
            const to = toPosix(entry?.to ?? '');
            if (!from || !to || from === to) continue;
            chain.set(from, { to, kind, stage });
        }
    }
    return chain;
}

/**
 * Walk the chain to the file that ended up on the disk.
 * @param {string} start the path the screen was born with
 * @param {Map<string, { to: string, kind: string, stage: string }>} chain
 * @returns {{ path: string, kind: string|null, steps: string[] }}
 * @ai.hint pure
 */
export function followChain(start, chain) {
    let current = toPosix(start ?? '');
    let kind = null;
    const steps = [];
    const seen = new Set();
    while (current && !seen.has(current)) {
        seen.add(current);
        const next = chain.get(current);
        if (!next) break;
        current = next.to;
        kind = next.kind;
        steps.push(next.stage);
    }
    return { path: current, kind, steps };
}

/**
 * A file name a person can read: Latin letters, digits and dashes.
 * @param {unknown} name the name the role gave the layer
 * @param {number} index the order of the layer
 * @returns {string}
 * @ai.hint pure
 */
export function layerSlug(name, index) {
    const clean = String(name ?? '')
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 32);
    return clean || `layer-${index + 1}`;
}

/**
 * Keep a box inside the frame of the picture.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ width: number, height: number }} frame
 * @returns {{ x: number, y: number, width: number, height: number }|null} null when the box is empty
 * @ai.hint pure
 */
export function clampBox(box, frame) {
    if (!frame?.width || !frame?.height) return null;
    const x = Math.max(0, Math.min(Math.round(box.x), frame.width - 1));
    const y = Math.max(0, Math.min(Math.round(box.y), frame.height - 1));
    const width = Math.min(Math.round(box.width), frame.width - x);
    const height = Math.min(Math.round(box.height), frame.height - y);
    if (width < 1 || height < 1) return null;
    return { x, y, width, height };
}

/**
 * Where the layers of the advanced mode come from.
 *
 * `auto` asks the image model when it is a seedream model — the only one that splits a picture
 * into layers itself — and falls back to the text role otherwise. The choice can be forced with
 * `stages.resolve.layerSource`.
 * @param {{ config?: object, imageModel?: string|null }} params
 * @returns {'seedream'|'director'}
 * @exports
 * @ai.hint pure
 */
export function resolveLayerSource({ config = null, imageModel = null } = {}) {
    const asked = String(config?.stages?.resolve?.layerSource ?? 'auto').trim().toLowerCase();
    if (asked === 'seedream' || asked === 'director') return asked;
    return isSeedream55(imageModel) ? 'seedream' : 'director';
}

/**
 * Run the resolve stage.
 * @param {object} state pipeline state
 * @param {Function} notify event callback
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function runResolve(state, notify = () => {}) {
    const {
        root, outDir = '.', config, roles, model, effort, advanced, warnings, toolset,
    } = state;
    const engine = config?.raster?.engine ?? 'auto';
    const chain = buildChain(state);

    // Every screen points at the file that ended up on the disk — and that file has to be there.
    const entries = [];
    const notes = [...(state?.decomposition?.notes ?? [])];
    for (const screen of state?.screens ?? []) {
        const name = String(screen?.name ?? '').trim() || '(unnamed)';
        const traced = followChain(screen?.subReference, chain);
        const located = traced.path
            ? await resolveInside(root, traced.path, { allowRoot: false }).catch(() => null)
            : null;
        const info = located ? await stat(located.abs).catch(() => null) : null;
        if (!info?.isFile()) {
            notes.push(`The screen "${name}" has no file (${traced.path || 'no path'}).`);
            entries.push({ screen, rel: null, kind: '', steps: traced.steps, missing: true });
            continue;
        }
        entries.push({
            screen,
            rel: traced.path,
            kind: traced.kind || screen?.subReferenceKind || 'crop',
            steps: traced.steps,
            missing: false,
        });
    }

    const resolved = {
        summary: state?.decomposition?.summary
            ?? `Decomposition of ${entries.length} screen(s)`,
        screens: entries.map((entry) => ({
            ...entry.screen,
            subReference: entry.rel,
            subReferenceKind: entry.kind,
            ...(entry.missing ? { missing: true } : {}),
        })),
        subReferences: entries.filter((entry) => entry.rel).map((entry) => ({
            path: entry.rel,
            screen: String(entry.screen?.name ?? '').trim(),
            kind: entry.kind,
            source: String(entry.screen?.source ?? '').trim(),
            note: entry.steps.length ? `produced by ${entry.steps.join(' → ')}` : '',
        })),
        notes,
        layers: [],
    };

    // Advanced mode: one screen split into layers.
    const wantLayers = Boolean(advanced || config?.stages?.resolve?.layers);
    if (wantLayers) {
        const target = entries.find((entry) => entry.rel);
        if (!target) {
            warnings.push('resolve: there is no screen to split into layers');
        } else {
            const split = await splitLayers({
                root,
                outDir,
                target: target.rel,
                config,
                roles,
                model,
                effort,
                toolset,
                engine,
                warnings,
                client: state?.client ?? null,
                imageModel: state?.imageModel ?? config?.imageModel ?? null,
                notify,
            });
            resolved.layers = split.layers;
            if (split.layers.length) {
                resolved.layersTarget = target.rel;
                resolved.layerFrame = split.frame;
                if (split.base) resolved.layerBase = split.base;
                notify({ type: 'resolve.layers', count: split.layers.length, target: target.rel });
            } else {
                warnings.push('resolve: the layer split produced no layers');
            }
        }
    }

    const jsonPath = path.join(root, outDir, DECOMPOSITION_FILE);
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(resolved, null, 2)}\n`);

    state.decomposition = resolved;
    state.outputPath = jsonPath;

    notify({
        type: 'resolve.done',
        path: jsonPath,
        screens: resolved.screens.length,
        layers: resolved.layers.length,
    });
}

/**
 * Split one screen into layers: the role names them with a box, the harness cuts the pixels.
 * @param {{ root: string, outDir: string, target: string, config: object, roles: object,
 *   model: string|null, effort: string|null, toolset: object|null, engine: string,
 *   warnings: string[], client?: object|null, imageModel?: string|null, notify?: Function }} params
 * @returns {Promise<{ layers: object[], frame: object|null, base?: object|null }>}
 * @ai.hint io
 */
async function splitLayers({ root, outDir, target, config, roles, model, effort, toolset, engine, warnings,
    client = null, imageModel = null, notify = () => {} }) {
    const source = resolveLayerSource({ config, imageModel });
    if (source === 'seedream') {
        return await splitLayersWithSeedream({ root, outDir, target, config, client, imageModel, engine, warnings, notify });
    }
    return await splitLayersWithDirector({ root, outDir, target, config, roles, model, effort, toolset, engine, warnings });
}

/**
 * Split one screen into layers with the image model: the model answers with a base picture and
 * transparent PNG layers, and the harness brings every layer file to the size of its box.
 *
 * The correction is the point of this path. The model scales every layer on its own to the chosen
 * tier, so the file of a layer is not the frame of its box: "each layer is scaled separately, so
 * the file size may differ from the bounding_box. When assembling, bring the layer to `w × h` and
 * place it at `(x, y)`." A layer written as it came would carry the size of its own canvas and the
 * box would say something else, and the two would not agree on the picture.
 * @param {{ root: string, outDir: string, target: string, config: object, client: object|null,
 *   imageModel: string|null, engine: string, warnings: string[], notify?: Function }} params
 * @returns {Promise<{ layers: object[], frame: object|null, base: object|null }>}
 * @ai.hint io
 */
async function splitLayersWithSeedream({ root, outDir, target, config, client, imageModel, engine, warnings, notify = () => {} }) {
    const abs = path.resolve(root, target);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) {
        warnings.push(`resolve: cannot read ${target}`);
        return { layers: [], frame: null, base: null };
    }
    const screenFrame = await rasterInfo(abs, { cwd: root, engine }).catch(() => null);
    if (!screenFrame?.width || !screenFrame?.height) {
        warnings.push(`resolve: cannot read the frame of ${target}`);
        return { layers: [], frame: null, base: null };
    }
    // The vendor refuses an input of more than 30 MiB or 36 million pixels.
    if (bytes.length > SEEDREAM_INPUT_MAX_BYTES) {
        warnings.push(`resolve: ${target} is too big for the seedream split (${bytes.length} bytes)`);
        return { layers: [], frame: null, base: null };
    }
    if (screenFrame.width * screenFrame.height > SEEDREAM_INPUT_MAX_PIXELS) {
        warnings.push(`resolve: ${target} is too big for the seedream split `
            + `(${screenFrame.width}x${screenFrame.height} pixels)`);
        return { layers: [], frame: null, base: null };
    }

    const model = imageModel || config?.imageModel || SEEDREAM_MODEL;
    const channels = typeof client?.channels === 'function' ? client.channels('images', model) : [];
    if (!channels.length) {
        warnings.push('resolve: no image backend is configured for the seedream layer split');
        return { layers: [], frame: null, base: null };
    }

    const maxLayers = Number.isSafeInteger(config?.stages?.resolve?.maxLayers)
        ? Math.max(0, config.stages.resolve.maxLayers)
        : 32;
    if (!maxLayers) {
        warnings.push('resolve: the layer split is disabled by the layer limit');
        return { layers: [], frame: null, base: null };
    }

    const layersDir = path.join(root, outDir, LAYERS_DIR);
    await mkdir(layersDir, { recursive: true });

    // The vendor counts the base among the outputs, so a request for N layers asks for N + 1.
    const prompt = String(config?.stages?.resolve?.layerPrompt ?? '').trim() || TIGHT_BOX_PROMPT;
    let decomposition;
    try {
        decomposition = await decomposeLayers({
            channels,
            model,
            source: { bytes, mime: sniffImage(bytes).mime },
            prompt,
            size: config?.stages?.resolve?.layerSize ?? 'auto',
            maxImages: Math.min(100, maxLayers + 1),
            textRecognition: config?.stages?.resolve?.textRecognition !== false,
            coordinateFrame: { width: screenFrame.width, height: screenFrame.height },
            onPoll: (data) => notify({ type: 'resolve.layers.poll', ...data }),
            onWarn: (message) => warnings.push(`resolve: ${message}`),
        });
    } catch (error) {
        warnings.push(`resolve: the seedream layer split failed (${model}): ${error?.message ?? error}`);
        return { layers: [], frame: null, base: null };
    }

    // The base picture is the canvas the boxes live in, so it is written first and its own size
    // becomes the frame of the layers.
    let base = null;
    let baseFrame = decomposition.base?.size?.width
        ? { width: decomposition.base.size.width, height: decomposition.base.size.height }
        : null;
    if (decomposition.base?.url) {
        const baseBytes = await downloadImageBytes(decomposition.base.url);
        if (baseBytes) {
            const baseFile = path.join(layersDir, '00-base.png');
            await writeFile(baseFile, baseBytes);
            const info = await rasterInfo(baseFile, { cwd: root, engine }).catch(() => null);
            if (info?.width && info?.height) baseFrame = { width: info.width, height: info.height };
            base = { path: toPosix(path.relative(root, baseFile)), frame: baseFrame };
        } else {
            warnings.push('resolve: the base picture of the decomposition was not downloaded');
        }
    }
    if (!baseFrame) baseFrame = { width: screenFrame.width, height: screenFrame.height };

    // The boxes are read on the canvas of the base; the frame of the screen that was sent is only
    // the fallback for an answer that reports neither.
    const parsed = parseLayerDecomposition(decomposition.raw, { baseFrame, coordinateFrame: screenFrame });

    const layers = [];
    for (const raw of parsed.layers) {
        if (layers.length >= maxLayers) {
            warnings.push(`resolve: more than ${maxLayers} layer(s) are kept`);
            break;
        }
        const name = layerSlug(raw?.name, raw?.index ?? layers.length);
        const box = raw?.box ? clampBox(raw.box, baseFrame) : null;
        if (!box) {
            warnings.push(`resolve: the layer "${name}" has no usable box`);
            continue;
        }
        const image = await downloadImageBytes(raw.url);
        if (!image) {
            warnings.push(`resolve: the layer "${name}" was not downloaded`);
            continue;
        }
        const file = `${String(layers.length + 1).padStart(2, '0')}-${name}.png`;
        const output = path.join(layersDir, file);
        await writeFile(output, image);
        // The correction: the file of the layer is scaled on its own, so it is brought to the box.
        let fitted = null;
        try {
            fitted = await rasterFitToBox({
                input: output,
                output,
                width: box.width,
                height: box.height,
                cwd: root,
                engine,
            });
        } catch (error) {
            warnings.push(`resolve: the layer "${name}" was not fitted to its box (${error?.message ?? error})`);
        }
        if (fitted && fitted.aspectDiff > 0.05) {
            warnings.push(`resolve: the layer "${name}" was drawn in a different proportion than its box `
                + `(${(fitted.aspectDiff * 100).toFixed(1)}%)`);
        }
        layers.push({
            name,
            description: String(raw?.description ?? '').trim(),
            path: toPosix(path.relative(root, output)),
            screen: target,
            box,
            z: Number.isFinite(raw?.z) ? raw.z : layers.length,
            ...(raw?.text ? { text: { text: raw.text.text, lines: raw.text.lines } } : {}),
        });
    }

    return { layers, frame: baseFrame, base };
}

/**
 * Split one screen into layers: the role names them with a box, the harness cuts the pixels.
 * @param {{ root: string, outDir: string, target: string, config: object, roles: object,
 *   model: string|null, effort: string|null, toolset: object|null, engine: string,
 *   warnings: string[] }} params
 * @returns {Promise<{ layers: object[], frame: object|null }>}
 * @ai.hint io
 */
async function splitLayersWithDirector({ root, outDir, target, config, roles, model, effort, toolset, engine, warnings }) {
    const abs = path.resolve(root, target);
    const bytes = await readFile(abs).catch(() => null);
    if (!bytes) {
        warnings.push(`resolve: cannot read ${target}`);
        return { layers: [], frame: null };
    }
    const frame = await rasterInfo(abs, { cwd: root, engine }).catch(() => null);
    if (!frame?.width || !frame?.height) {
        warnings.push(`resolve: cannot read the frame of ${target}`);
        return { layers: [], frame: null };
    }

    // The model sees a copy that fits into its frame; the boxes it answers with belong to that
    // copy, so the scale is remembered and the boxes are mapped back.
    let copy = bytes;
    let modelFrame = { width: frame.width, height: frame.height };
    try {
        const scaled = await downscaleToMaxSide(bytes, {
            maxSide: config?.image?.maxSide ?? null,
            maxMegapixels: config?.image?.maxMegapixels ?? null,
            engine,
        });
        copy = scaled.bytes;
        modelFrame = { width: scaled.width, height: scaled.height };
    } catch {
        // The picture goes to the model as it is; the boxes are then already in the source pixels.
    }

    const extraTools = toolset?.specsFor
        ? toolset.specsFor('director', DIRECTOR_TOOLS)
        : toolSpecs(config?.tools ?? {}, {
            role: 'director',
            names: DIRECTOR_TOOLS,
            imageApi: Boolean(config?.imageModel),
        });

    const resolvedRole = roles?.resolve?.('director');
    const brief = 'Split this screen into its visual layers: the background, the panels, the cards, the images, '
        + 'the icons and every block of text.\n'
        + 'Name every layer in English with Latin letters and digits only (nav-logo, hero-badge, price-card-1).\n'
        + 'The harness cuts the layers out of the picture itself, so write no file and give the box of every layer '
        + 'in the pixels of the picture you see.';
    const answer = await roles?.run?.('director', {
        text: `Screen: ${target}\nReturn the layers of this screen.`,
        parts: [imagePart(copy, sniffImage(copy).mime)],
        instructions: [resolvedRole?.instructions ?? ROLE_INSTRUCTIONS.director, brief].join('\n\n'),
        schema: LAYERS_SCHEMA,
        schemaName: 'layers',
        maxTurns: 1,
        model,
        effort,
        extraTools,
    });

    const named = Array.isArray(answer?.data?.layers) ? answer.data.layers : [];
    if (!named.length) return { layers: [], frame: null };

    const maxLayers = Number.isSafeInteger(config?.stages?.resolve?.maxLayers)
        ? Math.max(0, config.stages.resolve.maxLayers)
        : 32;
    const scaleX = modelFrame.width ? frame.width / modelFrame.width : 1;
    const scaleY = modelFrame.height ? frame.height / modelFrame.height : 1;
    const layersDir = path.join(root, outDir, LAYERS_DIR);
    await mkdir(layersDir, { recursive: true });

    const layers = [];
    for (const [index, raw] of named.entries()) {
        if (layers.length >= maxLayers) {
            warnings.push(`resolve: more than ${maxLayers} layer(s) are kept`);
            break;
        }
        const name = layerSlug(raw?.name, index);
        const box = clampBox({
            x: Number(raw?.x) * scaleX,
            y: Number(raw?.y) * scaleY,
            width: Number(raw?.width) * scaleX,
            height: Number(raw?.height) * scaleY,
        }, frame);
        if (!box) {
            warnings.push(`resolve: the layer "${name}" has no usable box`);
            continue;
        }
        const file = `${String(layers.length + 1).padStart(2, '0')}-${name}.png`;
        const output = path.join(layersDir, file);
        try {
            await rasterCrop({
                input: abs,
                output,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                cwd: root,
                engine,
            });
        } catch (error) {
            warnings.push(`resolve: the layer "${name}" was not cut (${error?.message ?? error})`);
            continue;
        }
        layers.push({
            name,
            description: String(raw?.description ?? '').trim(),
            path: toPosix(path.relative(root, output)),
            screen: target,
            box,
        });
    }

    return { layers, frame: { width: frame.width, height: frame.height } };
}
