/**
 * @file src/agent/tools.js
 * @purpose The executor of the tools: it runs the calls the model asks for inside the working
 *          directory and answers with a short text the model can read.
 * @depends image/raster, openai/images, agent/tool-specs, agent/mcp
 * @exports createToolset, toolSpecs, enabledToolNames
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rasterCrop, rasterInfo, rasterCompare } from '../image/raster.js';
import { sniffImage } from '../openai/images.js';
import { toolSpecs as buildSpecs } from './tool-specs.js';

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
 * @param {{ root: string, config: object, client?: object, role?: string|null, mcp?: object[] }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[] }}
 */
export function createToolset({ root, config, client, role = null, mcp = [] }) {
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

    async function execute(name, args) {
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

    return {
        execute,
        specs,
        /** The tool list of one role: the catalogue, cut down to what that role may call. */
        specsFor(role, names = null) {
            const local = buildSpecs(config?.tools, { role, names, imageApi });
            if (names) {
                const wanted = new Set(names);
                return [...local, ...mcpSpecs.filter((spec) => wanted.has(spec.name))];
            }
            return [...local, ...mcpSpecs];
        },
    };
}