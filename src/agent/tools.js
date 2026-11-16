/**
 * @file src/agent/tools.js
 * @purpose The executor of the tools: it runs the calls the model asks for inside the working
 *          directory and answers with a short text the model can read.
 * @depends image/raster, image/crop, openai/images, agent/tool-specs, agent/mcp, agent/paths,
 *   agent/cli-family, shared/house
 * @exports createToolset, toolSpecs, enabledToolNames, BLOCKING_COMMANDS
 * @ai.hint keep
 * @ai.hint legacy-0.2
 * @changed 2026-11-16 Свободная дверь к CLI семейства: `ai_cli` зовёт любой CLI дома с любым
 *                       флагом, `ai_cli_help` даёт руководство по нему.
 */
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { rasterCrop, rasterInfo, rasterCompare, rasterSplit } from '../image/raster.js';
import { clampRect, cropRect } from '../image/crop.js';
import { sniffImage } from '../openai/images.js';
import { toolSpecs as buildSpecs } from './tool-specs.js';
import { isInside, resolveInside } from './paths.js';
import {
    FAMILY_CLIS,
    FAMILY_ROOT,
    FAMILY_TIMEOUT_MS,
    familyDoc,
    familyNames,
    familyOutputArg,
    familyPathArgs,
    resolveFamilyCli,
    runFamilyCli,
} from './cli-family.js';
import { writeFileAtomic } from '../shared/house.js';

export { toolSpecs, enabledToolNames } from './tool-specs.js';

/**
 * The commands that do not finish on their own.
 *
 * A server or a watcher holds the run until the timeout and brings nothing: the work of the
 * run would wait for a process that was never going to end.
 */
export const BLOCKING_COMMANDS = /(?:python[0-9.]*\s+-m\s+http\.server|\bhttp-server\b|\blive-server\b|\bserve\b|(?:^|\s)(?:npx\s+)?vite\b(?!\s+build)|\bnpm\s+run\s+(?:dev|preview|serve|start)\b|\btail\s+-f\b)/i;

/**
 * The argument list of a tool: a JSON array of strings.
 * @param {unknown} raw
 * @returns {string[]}
 * @ai.hint pure
 */
function parseArgsList(raw) {
    if (Array.isArray(raw)) return raw.map((item) => String(item));
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch { /* not JSON: treat it as one argument */ }
    return [raw];
}

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
 *   writeDirs?: string[], env?: object }} opts
 * @returns {{ execute: (name: string, args: object) => Promise<string>, specs: object[], setWriteDirs: Function }}
 */
export function createToolset({ root, config, client, role = null, mcp = [], writeDirs = null, env = process.env }) {
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

    /**
     * Resolve a directory the files of a command land in, and refuse the ones outside the
     * allowed dirs.
     *
     * The root itself is allowed here: a command that writes into the working directory is
     * the normal case, and the stage that opened the directories knows what it opened.
     * @param {string} value
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    async function writeDirPath(value) {
        const located = await resolveInside(root, String(value ?? ''), { forWrite: true, allowRoot: true });
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
                const angles = result.angles ?? {};
                return `Perspective corrected → ${result.rel} (${result.width}×${result.height}, `
                    + `turned ${angles.rotation ?? 0}°, skewed ${angles.skew ?? 0}°, `
                    + `keystone ${angles.keystone ?? 0}°, residual tilt ${result.residual?.angleDeg ?? 0}°)`;
            }
            case 'apply_matrix': {
                const { matrixRectify } = await import('../image/matrix.js');
                const located = await readPath(args.path);
                const parsed = path.parse(located.abs);
                const fallback = path.join(parsed.dir, `${parsed.name}-warped.png`);
                const target = await writePath(args.output ?? fallback);
                const result = await matrixRectify({
                    input: located.abs,
                    output: target.abs,
                    matrix: args.matrix_json,
                    cwd: root,
                    engine,
                });
                const angles = result.angles ?? {};
                return `Warped by a ${result.matrix.size}×${result.matrix.size} matrix → ${result.rel} `
                    + `(${result.width}×${result.height}, turned ${angles.rotation ?? 0}°, `
                    + `skewed ${angles.skew ?? 0}°, residual tilt ${result.residual?.angleDeg ?? 0}°)`;
            }
            case 'magick': {
                const { parseMagickArgs, forbiddenMagickArg, magickOutputFile, runMagick } =
                    await import('../image/magick-cli.js');
                const line = parseMagickArgs(args.args ?? args.args_text ?? args.command);
                if (!line.length) return 'ImageMagick: the command line is empty.';
                for (const arg of line) {
                    const reason = forbiddenMagickArg(arg);
                    if (reason) return `ImageMagick: ${reason}`;
                }
                // Every path of the command stays inside the root of the run.
                for (const arg of line) {
                    if (arg.startsWith('-')) continue;
                    if (!/[\\/]/.test(arg) && !/\.[a-zA-Z0-9]{1,5}$/.test(arg)) continue;
                    try {
                        await resolveInside(root, arg, { allowRoot: false });
                    } catch (error) {
                        return `ImageMagick: ${error.message}`;
                    }
                }
                // The file that is written lands in a directory the stage opened for writing.
                const output = magickOutputFile(line);
                if (output) {
                    try {
                        await writePath(output);
                    } catch (error) {
                        return `ImageMagick: ${error.message}`;
                    }
                }
                const result = await runMagick({
                    args: line,
                    cwd: root,
                    exe: config?.raster?.magickPath ?? null,
                });
                const lines = [`ImageMagick: exit ${result.code}`];
                if (result.stdout.trim()) lines.push(result.stdout.trim());
                if (result.stderr.trim()) lines.push(result.stderr.trim());
                if (output) lines.push(`The result is written to ${output}`);
                return lines.join('\n');
            }
            case 'magick_help': {
                const { magickDoc } = await import('../image/magick-docs.js');
                return magickDoc(args.topic);
            }
            case 'ai_cli': {
                const name = String(args.cli ?? '').trim();
                if (!name) return 'The CLI is not named.';
                if (!FAMILY_CLIS[name]) {
                    return `The CLI "${name}" is not one of the house: ${familyNames().join(', ')}. `
                        + 'Read the manual with the tool `ai_cli_help`.';
                }
                const list = parseArgsList(args.args);
                const line = [name, ...list].join(' ');
                // A server or a watcher does not finish on its own: it would hold the run
                // until the timeout, and the work of the run would wait for nothing.
                if (BLOCKING_COMMANDS.test(line)) {
                    return 'The command is not started: it does not finish on its own. '
                        + 'Check the files of the project or start such a command in the background of a shell.';
                }
                // Every path of the command stays inside the root of the run.
                for (const arg of familyPathArgs(list)) {
                    try {
                        await resolveInside(root, arg, { allowRoot: false });
                    } catch (error) {
                        return `The CLI "${name}": ${error.message}`;
                    }
                }
                // The files of the result land in a directory the stage opened for writing.
                const output = familyOutputArg(list);
                if (output) {
                    try {
                        await writeDirPath(output);
                    } catch (error) {
                        return `The CLI "${name}": ${error.message}`;
                    }
                }
                const found = await resolveFamilyCli(name, { root: FAMILY_ROOT, env });
                if (!found) {
                    const spec = FAMILY_CLIS[name];
                    return `The CLI "${name}" is not installed: set ${spec.env} `
                        + `or install ${spec.package ?? 'the package'}.`;
                }
                const timeoutMs = Number.isSafeInteger(Number(args.timeoutMs))
                    ? Number(args.timeoutMs)
                    : FAMILY_TIMEOUT_MS;
                const result = await runFamilyCli({ found, args: list, cwd: root, env, timeoutMs });
                const parts = [`${name} → code ${result.code ?? 0}${result.timedOut ? ' (the time is over)' : ''}`];
                if (result.stdout.trim()) parts.push(result.stdout.trim());
                if (result.stderr.trim()) parts.push(result.stderr.trim());
                return parts.join('\n');
            }
            case 'ai_cli_help':
                return familyDoc(args.topic);
            case 'generate_image': {
                if (!client?.images) return 'Images API unavailable';
                const { images } = await client.images.generate({
                    model: config.imageModel, prompt: args.prompt, size: args.size ?? '1024x1024', format: 'png',
                });
                if (images?.length) {
                    const target = await writePath(args.output ?? 'generated.png');
                    await writeFileAtomic(target.abs, images[0].bytes);
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
                    await writeFileAtomic(target.abs, images[0].bytes);
                    return `Edited → ${target.rel}`;
                }
                return 'Edit returned empty';
            }
            case 'write_file': {
                const target = await writePath(args.path);
                await mkdir(path.dirname(target.abs), { recursive: true });
                // The file of the model appears whole: a reader never sees half of it.
                await writeFileAtomic(target.abs, args.content);
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
