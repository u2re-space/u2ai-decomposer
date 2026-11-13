/**
 * @file src/agent/tools.js
 * @purpose Tool registry and executor for image operations.
 * @exports createToolset, enabledToolNames
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rasterCrop, rasterInfo, rasterCompare } from '../image/raster.js';
import { sniffImage } from '../openai/images.js';

/**
 * Available tools for the decomposer domain.
 */
const TOOL_DEFS = {
    view_image: { description: 'View an image file', params: { path: { type: 'string' } } },
    crop_image: { description: 'Crop a region from an image', params: { path: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, output: { type: 'string' } } },
    split_image: { description: 'Split image into grid tiles', params: { path: { type: 'string' }, rows: { type: 'number' }, cols: { type: 'number' }, outputDir: { type: 'string' } } },
    compare_images: { description: 'Compare two images pixel-by-pixel', params: { before: { type: 'string' }, after: { type: 'string' } } },
    correct_perspective: { description: 'Apply perspective correction via quad corners', params: { path: { type: 'string' }, corners_json: { type: 'string' }, output: { type: 'string' } } },
    generate_image: { description: 'Generate an image from prompt', params: { prompt: { type: 'string' }, reference: { type: 'string' }, output: { type: 'string' }, size: { type: 'string' } } },
    edit_image: { description: 'Edit an image with a prompt', params: { image: { type: 'string' }, prompt: { type: 'string' }, output: { type: 'string' } } },
    write_file: { description: 'Write content to a file', params: { path: { type: 'string' }, content: { type: 'string' } } },
    read_file: { description: 'Read a file', params: { path: { type: 'string' } } },
};

/**
 * The tool definitions in the Responses API shape.
 * @param {object} [tools] the `tools` section of the config; a false value disables a tool
 * @returns {object[]}
 */
export function toolSpecs(tools = {}) {
    const out = [];
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
        if (tools?.[name] === false) continue;
        out.push({
            type: 'function',
            name,
            description: def.description,
            parameters: {
                type: 'object',
                properties: def.params,
                required: Object.keys(def.params).filter((key) => !['output', 'outputDir', 'size'].includes(key)),
                additionalProperties: false,
            },
        });
    }
    return out;
}


/**
 * Get enabled tool names for a role.
 * @param {object} tools config
 * @param {{ imageApi?: boolean }} [opts]
 * @returns {string[]}
 */
export function enabledToolNames(tools, opts = {}) {
    const names = [];
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
        if (tools[name] === false) continue;
        if (!opts.imageApi && ['generate_image', 'edit_image'].includes(name)) continue;
        names.push(name);
    }
    return names;
}

/**
 * Create a toolset executor bound to a working directory.
 * @param {{ root: string, config: object, client?: object }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[] }}
 */
export function createToolset({ root, config, client }) {
    const engine = config.raster?.engine ?? 'auto';
    const specs = toolSpecs(config?.tools);

    async function execute(name, args) {
        switch (name) {
            case 'view_image': {
                const abs = path.resolve(root, args.path);
                const info = await rasterInfo(abs, { cwd: root, engine });
                return `Image ${args.path}: ${info.width}×${info.height} ${info.format ?? ''}`;
            }
            case 'crop_image': {
                const abs = path.resolve(root, args.path);
                const outAbs = path.resolve(root, args.output ?? args.path.replace('.', '-crop.'));
                await rasterCrop({ input: abs, output: outAbs, x: args.x, y: args.y, width: args.width, height: args.height, cwd: root, engine });
                return `Cropped to ${outAbs}`;
            }
            case 'split_image': {
                const abs = path.resolve(root, args.path);
                const info = await rasterInfo(abs, { cwd: root, engine });
                const tileW = Math.floor(info.width / (args.cols || 1));
                const tileH = Math.floor(info.height / (args.rows || 1));
                const outDir = path.resolve(root, args.outputDir ?? '.');
                await mkdir(outDir, { recursive: true });
                for (let r = 0; r < (args.rows || 1); r++) {
                    for (let c = 0; c < (args.cols || 1); c++) {
                        const out = path.join(outDir, `tile-${r}-${c}.png`);
                        await rasterCrop({ input: abs, output: out, x: c * tileW, y: r * tileH, width: tileW, height: tileH, cwd: root, engine });
                    }
                }
                return `Split into ${(args.rows||1)*(args.cols||1)} tiles in ${outDir}`;
            }
            case 'compare_images': {
                const before = await readFile(path.resolve(root, args.before));
                const after = await readFile(path.resolve(root, args.after));
                const delta = await rasterCompare({ before, after, engine });
                return `Difference: mean ${delta.meanDelta.toFixed(2)}/255, changed ${(delta.changedShare * 100).toFixed(1)}% of ${delta.width}×${delta.height}`;
            }
            case 'correct_perspective': {
                const { perspectiveRectify } = await import('../image/rectify.js');
                const abs = path.resolve(root, args.path);
                const corners = JSON.parse(args.corners_json);
                const outAbs = path.resolve(root, args.output ?? abs.replace('.', '-rectified.'));
                const result = await perspectiveRectify({
                    input: abs,
                    output: outAbs,
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
                    const outAbs = path.resolve(root, args.output ?? 'generated.png');
                    await writeFile(outAbs, images[0].bytes);
                    return `Generated → ${outAbs}`;
                }
                return 'Generation returned empty';
            }
            case 'edit_image': {
                if (!client?.images) return 'Images API unavailable';
                const abs = path.resolve(root, args.image);
                const bytes = await readFile(abs);
                const { images } = await client.images.edit({
                    model: config.imageModel,
                    prompt: args.prompt,
                    format: 'png',
                    image: { filename: path.basename(abs), mime: sniffImage(bytes).mime, bytes },
                });
                if (images?.length) {
                    const outAbs = path.resolve(root, args.output ?? abs.replace('.', '-edited.'));
                    await writeFile(outAbs, images[0].bytes);
                    return `Edited → ${outAbs}`;
                }
                return 'Edit returned empty';
            }
            case 'write_file': {
                const abs = path.resolve(root, args.path);
                await mkdir(path.dirname(abs), { recursive: true });
                await writeFile(abs, args.content);
                return `Written ${args.path}`;
            }
            case 'read_file': {
                const abs = path.resolve(root, args.path);
                return await readFile(abs, 'utf-8');
            }
            default:
                return `Unknown tool: ${name}`;
        }
    }

    return { execute, specs };
}