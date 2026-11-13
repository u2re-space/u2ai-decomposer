/**
 * @file src/agent/tools.js
 * @purpose Tool registry and executor for image operations.
 * @exports createToolset, enabledToolNames
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rasterCrop, rasterPatch, rasterInfo, decodeRgba } from '../image/raster.js';
import { createClient } from '../openai/client.js';

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
 * @returns {{ execute: (name: string, args: object) => Promise<string> }}
 */
export function createToolset({ root, config, client }) {
    const engine = config.image?.rasterEngine ?? 'auto';

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
            case 'correct_perspective': {
                const { perspectiveRectify } = await import('../image/rectify.js');
                const abs = path.resolve(root, args.path);
                const corners = JSON.parse(args.corners_json);
                const outAbs = path.resolve(root, args.output ?? abs.replace('.', '-rectified.'));
                await perspectiveRectify(abs, corners, outAbs, { cwd: root, engine });
                return `Perspective corrected → ${outAbs}`;
            }
            case 'generate_image': {
                if (!client?.images) return 'Images API unavailable';
                const payloads = await client.images.generate({ model: config.imageModel, prompt: args.prompt, size: args.size ?? '1024x1024', format: 'png' });
                if (payloads?.length) {
                    const outAbs = path.resolve(root, args.output ?? 'generated.png');
                    await writeFile(outAbs, Buffer.from(payloads[0], 'base64'));
                    return `Generated → ${outAbs}`;
                }
                return 'Generation returned empty';
            }
            case 'edit_image': {
                if (!client?.images) return 'Images API unavailable';
                const abs = path.resolve(root, args.image);
                const bytes = await readFile(abs);
                const payloads = await client.images.edit({ model: config.imageModel, prompt: args.prompt, format: 'png', files: [{ filename: path.basename(abs), mime: 'image/png', bytes }] });
                if (payloads?.length) {
                    const outAbs = path.resolve(root, args.output ?? abs.replace('.', '-edited.'));
                    await writeFile(outAbs, Buffer.from(payloads[0], 'base64'));
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

    return { execute };
}