/**
 * @file src/agent/tools.js
 * @purpose The executor of the tools: it runs the calls the model asks for inside the working
 *          directory and answers with a short text the model can read.
 * @depends image/raster, image/crop, openai/images, agent/tool-specs, agent/mcp, agent/paths
 * @exports createToolset, toolSpecs, enabledToolNames
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rasterCrop, rasterInfo, rasterCompare, rasterSplit } from '../image/raster.js';
import { clampRect, cropRect } from '../image/crop.js';
import { sniffImage } from '../openai/images.js';
import { toolSpecs as buildSpecs } from './tool-specs.js';
import { isInside, resolveInside } from './paths.js';

export { toolSpecs, enabledToolNames } from './tool-specs.js';

/**
 * Turn a name into a token the API accepts.
 * @param {string} value
 * @returns {string}
 * @ai.hint pure
 */
function token(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The tools of the connected MCP servers, named so that two servers cannot collide.
 *
 * @param {Array<{ name: string, tools: object[], call: Function }>} connections
 * @returns {Array<{ name: string, description: string, parameters: object, connection: object, tool: string }>}
 * @ai.hint pure
 */
export function mcpToolEntries(connections = []) {
    const out = [];
    for (const [index, connection] of (connections ?? []).entries()) {
        const prefix = `mcp_${token(connection?.name ?? index)}`;
        for (const tool of connection?.tools ?? []) {
            if (!tool || typeof tool.name !== 'string') continue;
            out.push({
                name: `${prefix}_${token(tool.name)}`,
                description: String(tool.description ?? ''),
                parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
                    ? tool.inputSchema
                    : { type: 'object', properties: {} },
                connection,
                tool: tool.name,
            });
        }
    }
    return out;
}

/**
 * Create a toolset executor bound to a working directory.
 *
 * Every path the model names is resolved inside the working directory, and every file the model
 * writes has to land in one of the directories the current stage opened for writing. The stage
 * that runs the role decides where its artifacts may go; the executor refuses anything else.
 * @param {{ root: string, config: object, client?: object, role?: string|null, mcp?: object[],
 *   writeDirs?: string[] }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[], setWriteDirs: Function }}
 */
export function createToolset({ root, config, client, role = null, mcp = [], writeDirs = null }) {
    const engine = config.raster?.engine ?? 'auto';
    const imageApi = Boolean(client?.images);
    const mcpTools = mcpToolEntries(mcp);
    const mcpSpecs = mcpTools.map((entry) => ({
        type: 'function',
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
    }));
    const specs = [...buildSpecs(config?.tools, { role, imageApi }), ...mcpSpecs];
    let allowed = (writeDirs ?? [root]).map((dir) => path.resolve(dir));

    /**
     * Resolve a path the model wants to read.
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function readPath(value) {
        return await resolveInside(root, String(value ?? ''), { allowRoot: false });
    }

    /**
     * Resolve a path the model wants to write, and refuse the ones outside the allowed dirs.
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function writePath(value) {
        const located = await resolveInside(root, String(value ?? ''), { forWrite: true, allowRoot: false });
        if (!allowed.some((dir) => isInside(dir, located.abs))) {
            throw new Error(`Writing outside the output directory is forbidden: ${located.rel}`);
        }
        return located;
    }

    async function execute(name, args = {}) {
        const mcpTool = mcpTools.find((entry) => entry.name === name);
        if (mcpTool) {
            const result = await mcpTool.connection.call(mcpTool.tool, args ?? {});
            const content = Array.isArray(result?.content) ? result.content : null;
            if (content) {
                return content
                    .map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
                    .join('\n');
            }
            return typeof result === 'string' ? result : JSON.stringify(result ?? null);
        }
        switch (name) {
            case 'view_image': {
                const located = await readPath(args.path);
                const info = await rasterInfo(located.abs, { cwd: root, engine });
                return `Image ${located.rel}: ${info.width}×${info.height} ${info.format ?? ''}`;
            }
            case 'crop_image': {
                const located = await readPath(args.path);
                const parsed = path.parse(located.abs);
                const fallback = path.join(parsed.dir, `${parsed.name}-crop.png`);
                const target = await writePath(args.output ?? fallback);
                const info = await rasterInfo(located.abs, { cwd: root, engine });
                const box = clampRect(args, info);
                await rasterCrop({ input: located.abs, output: target.abs, ...box, cwd: root, engine });
                return `Cropped to ${target.rel} (${box.width}×${box.height})`;
            }
            case 'split_image': {
                const located = await readPath(args.path);
                const outDir = await writePath(args.outputDir ?? '.');
                await mkdir(outDir.abs, { recursive: true });
                const tiles = await rasterSplit({
                    input: located.abs,
                    outputDir: outDir.abs,
                    rows: Math.max(1, Number(args.rows) || 1),
                    cols: Math.max(1, Number(args.cols) || 1),
                    cwd: root,
                    engine,
                    baseName: 'tile',
                });
                return `Split into ${tiles.length} tiles in ${outDir.rel}`;
            }
            case 'compare_images': {
                const before = await readFile((await readPath(args.before)).abs);
                const after = await readFile((await readPath(args.after)).abs);
                const delta = await rasterCompare({ before, after, engine });
                return `Difference: mean ${delta.meanDelta.toFixed(2)}/255, changed ${(delta.changedShare * 100).toFixed(1)}% of ${delta.width}×${delta.height}`;
            }
            case 'correct_perspective': {
                const { perspectiveRectify } = await import('../image/rectify.js');
                const located = await readPath(args.path);
                const corners = JSON.parse(args.corners_json);
                const parsed = path.parse(located.abs);
                const fallback = path.join(parsed.dir, `${parsed.name}-rectified.png`);
                const target = await writePath(args.output ?? fallback);
                const result = await perspectiveRectify({
                    input: located.abs,
                    output: target.abs,
                    quad: corners,
                    cwd: root,
                    engine,
                });
                return `Perspective corrected → ${result.rel} (${result.width}×${result.height}, residual tilt ${result.residual?.angleDeg ?? 0}°)`;
            }
            case 'generate_image': {
                if (!client?.images) return 'Images API unavailable';
                const { images } = await client.images.generate({
                    model: config.imageModel, prompt: args.prompt, size: args.size ?? '1024x1024', format: 'png',
                });
                if (images?.length) {
                    const target = await writePath(args.output ?? 'generated.png');
                    await writeFile(target.abs, images[0].bytes);
                    return `Generated → ${target.rel}`;
                }
                return 'Generation returned empty';
            }
            case 'edit_image': {
                if (!client?.images) return 'Images API unavailable';
                const located = await readPath(args.image);
                const bytes = await readFile(located.abs);
                const { images } = await client.images.edit({
                    model: config.imageModel,
                    prompt: args.prompt,
                    format: 'png',
                    image: { filename: path.basename(located.abs), mime: sniffImage(bytes).mime, bytes },
                });
                if (images?.length) {
                    const parsed = path.parse(located.abs);
                    const fallback = path.join(parsed.dir, `${parsed.name}-edited.png`);
                    const target = await writePath(args.output ?? fallback);
                    await writeFile(target.abs, images[0].bytes);
                    return `Edited → ${target.rel}`;
                }
                return 'Edit returned empty';
            }
            case 'write_file': {
                const target = await writePath(args.path);
                await mkdir(path.dirname(target.abs), { recursive: true });
                await writeFile(target.abs, args.content);
                return `Written ${target.rel}`;
            }
            case 'read_file': {
                const located = await readPath(args.path);
                return await readFile(located.abs, 'utf-8');
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }

    return {
        execute,
        specs,
        /**
         * The tool list of one role: the catalogue, cut down to what that role may call.
         * @param {string} role
         * @param {string[]|null} names
         * @returns {object[]}
         */
        specsFor(role, names = null) {
            const local = buildSpecs(config?.tools, { role, names, imageApi });
            if (names) {
                const wanted = new Set(names);
                return [...local, ...mcpSpecs.filter((spec) => wanted.has(spec.name))];
            }
            return [...local, ...mcpSpecs];
        },
        /**
         * Open these directories for writing; every other path is refused.
         * @param {string[]} dirs
         */
        setWriteDirs(dirs) {
            allowed = (dirs ?? []).map((dir) => path.resolve(dir));
        },
        /** The directories the model may write into right now. */
        writeDirs() {
            return [...allowed];
        },
    };
}
