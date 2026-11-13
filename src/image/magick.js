/**
 * @file src/image/magick.js
 * @module image/magick
 * @purpose Detect ImageMagick and run it for the operations the local raster engines do not cover.
 *
 *   ImageMagick is the last resort of the raster chain: sharp and node-canvas do the work in
 *   process, and this module only matters on a machine where neither native module is available.
 *   Every call goes through `execFile` with an argument array, so no shell is involved and a path
 *   with spaces or quotes cannot turn into a second command.
 *
 * @depends node:child_process, node:path, node:fs/promises
 * @usedBy image/crop, image/padding (fallback path)
 * @exports detectMagick, magickCrop, magickSplit, magickResize, magickConvert, magickIdentify,
 *   magickPadImageBytes, magickRemoveImagePadding
 * @ai.tags imagemagick, image, crop, split, padding
 * @ai.hint io
 * @ai.hint legacy-0.2
 *
 * Ported from the monolith (`src/shared/image-magick.js`): the shell runner was replaced with
 * `execFile`, the messages were translated, and the helpers were narrowed to the ones the
 * decomposer actually calls.
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

/** Cached detection result. null = not checked yet, false = not available, string = the executable. */
let _magickPath = null;

/**
 * Detect the ImageMagick executable.
 *
 * @param {{ magickPath?: string|null }} [options] — an explicit path from the config wins
 * @returns {Promise<string|null>} the executable, or null when ImageMagick is not installed
 * @exports
 * @ai.hint io
 */
export async function detectMagick({ magickPath = null } = {}) {
    if (magickPath) {
        const ok = await probeMagick(magickPath);
        return ok ? magickPath : null;
    }
    if (_magickPath !== null) return _magickPath || null;
    const candidates = process.platform === 'win32'
        ? ['magick', 'convert']
        : ['magick', 'convert', '/usr/bin/magick', '/usr/local/bin/convert'];
    for (const exe of candidates) {
        if (await probeMagick(exe)) {
            _magickPath = exe;
            return exe;
        }
    }
    _magickPath = false;
    return null;
}

/**
 * Run `magick -version` and check that the answer really is ImageMagick.
 * @param {string} exe
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function probeMagick(exe) {
    try {
        const { stdout } = await execFileAsync(exe, ['-version'], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 });
        return /ImageMagick/i.test(stdout);
    } catch {
        return false;
    }
}

/**
 * Run one ImageMagick command.
 *
 * @param {string} exe
 * @param {string[]} args
 * @param {{ cwd?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @ai.hint io
 */
async function magickRun(exe, args, { cwd = process.cwd(), signal = null, timeoutMs = 30000 } = {}) {
    const options = {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        signal: signal ?? undefined,
    };
    try {
        const { stdout, stderr } = await execFileAsync(exe, args, options);
        return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
        throw new Error(`ImageMagick (${args.join(' ')}): ${error.stderr || error.message}`);
    }
}

/**
 * Crop a region from an image.
 *
 * @param {{ exe: string, input: string, output: string, x: number, y: number, width: number,
 *   height: number, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickCrop({ exe, input, output, x, y, width, height, cwd = process.cwd(), signal = null }) {
    const geometry = `${width}x${height}+${x}+${y}`;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await magickRun(exe, [input, '-crop', geometry, '+repage', outPath], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Split an image into a grid of rows × cols tiles.
 *
 * @param {{ exe: string, input: string, outputDir: string, rows: number, cols: number,
 *   cwd?: string, signal?: AbortSignal, baseName?: string }} options
 * @returns {Promise<Array<{ rel: string, row: number, col: number, x: number, y: number,
 *   width: number, height: number, bytes: number }>>}
 * @exports
 * @ai.hint io
 */
export async function magickSplit({ exe, input, outputDir, rows, cols, cwd = process.cwd(), signal = null, baseName = 'tile' }) {
    const identify = await magickRun(exe, [input, '-format', '%w %h', 'info:'], { cwd, signal });
    const [imgW, imgH] = identify.stdout.trim().split(/\s+/).map(Number);
    if (!imgW || !imgH) throw new Error(`Cannot read the dimensions of: ${input}`);
    const tileW = Math.floor(imgW / cols);
    const tileH = Math.floor(imgH / rows);
    const outAbs = path.isAbsolute(outputDir) ? outputDir : path.join(cwd, outputDir);
    await mkdir(outAbs, { recursive: true });
    const tiles = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const x = col * tileW;
            const y = row * tileH;
            const width = col === cols - 1 ? imgW - x : tileW;
            const height = row === rows - 1 ? imgH - y : tileH;
            const geometry = `${width}x${height}+${x}+${y}`;
            const rel = path.join(outAbs, `${baseName}_r${row + 1}c${col + 1}.png`);
            await magickRun(exe, [input, '-crop', geometry, '+repage', rel], { cwd, signal });
            const info = await stat(rel).catch(() => null);
            tiles.push({ rel, row: row + 1, col: col + 1, x, y, width, height, bytes: info?.size ?? 0 });
        }
    }
    return tiles;
}

/**
 * Resize an image to the given dimensions.
 *
 * @param {{ exe: string, input: string, output: string, width: number, height?: number|null,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickResize({ exe, input, output, width, height = null, cwd = process.cwd(), signal = null }) {
    const size = height ? `${width}x${height}` : `${width}x`;
    const outPath = path.isAbsolute(output) ? output : path.join(cwd, output);
    await mkdir(path.dirname(outPath), { recursive: true });
    await magickRun(exe, [input, '-resize', size, outPath], { cwd, signal });
    const info = await stat(outPath).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Convert an image to another format.
 *
 * @param {{ exe: string, input: string, output: string, quality?: number|null,
 *   cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ rel: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickConvert({ exe, input, output, quality = null, cwd = process.cwd(), signal = null }) {
    const args = [input];
    if (quality != null) args.push('-quality', String(quality));
    args.push(path.isAbsolute(output) ? output : path.join(cwd, output));
    await magickRun(exe, args, { cwd, signal });
    const info = await stat(path.isAbsolute(output) ? output : path.join(cwd, output)).catch(() => null);
    return { rel: output, bytes: info?.size ?? 0 };
}

/**
 * Read the metadata of an image.
 *
 * @param {{ exe: string, input: string, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ width: number, height: number, format: string, bytes: number }>}
 * @exports
 * @ai.hint io
 */
export async function magickIdentify({ exe, input, cwd = process.cwd(), signal = null }) {
    const res = await magickRun(exe, [input, '-format', '%w %h %m %B', 'info:'], { cwd, signal });
    const parts = res.stdout.trim().split(/\s+/);
    return {
        width: Number(parts[0]) || 0,
        height: Number(parts[1]) || 0,
        format: parts[2] ?? '',
        bytes: Number(parts[3]) || 0,
    };
}

/**
 * Add transparent pixels to the right and the bottom without touching the source pixels.
 *
 * The frame is raised above the 16-pixel grid a model works on, and the source stays in the
 * top-left corner, so the reply can be cut back the same way.
 *
 * @param {{ exe: string, bytes: Buffer, signal?: AbortSignal, targetWidth?: number|null,
 *   targetHeight?: number|null }} options
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, originalWidth: number,
 *   originalHeight: number, padded: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function magickPadImageBytes({ exe, bytes, signal = null, targetWidth = null, targetHeight = null }) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-pad-'));
    const input = path.join(dir, 'input');
    const output = path.join(dir, 'padded.png');
    try {
        await writeFile(input, bytes);
        const info = await magickIdentify({ exe, input, cwd: dir, signal });
        if (!info.width || !info.height) throw new Error('Cannot read the dimensions of the input image.');
        const width = Math.max(Math.ceil(info.width / 16) * 16, Math.ceil(Math.max(1, Number(targetWidth) || 1) / 16) * 16);
        const height = Math.max(Math.ceil(info.height / 16) * 16, Math.ceil(Math.max(1, Number(targetHeight) || 1) / 16) * 16);
        if (width === info.width && height === info.height) {
            return { bytes, width, height, originalWidth: width, originalHeight: height, padded: false };
        }
        await magickRun(exe, [input, '-background', 'none', '-gravity', 'northwest', '-extent', `${width}x${height}`, output], { cwd: dir, signal });
        return {
            bytes: await readFile(output),
            width,
            height,
            originalWidth: info.width,
            originalHeight: info.height,
            padded: true,
        };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Remove the known right/bottom padding by its boundary; never resize the generated pixels.
 *
 * @param {{ exe: string, bytes: Buffer, width: number, height: number, originalWidth: number,
 *   originalHeight: number, signal?: AbortSignal, normalized?: boolean }} options
 * @returns {Promise<Buffer>}
 * @exports
 * @ai.hint io
 */
export async function magickRemoveImagePadding({
    exe, bytes, width, height, originalWidth, originalHeight, signal = null, normalized = false,
}) {
    if (width === originalWidth && height === originalHeight) return bytes;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-image-unpad-'));
    const input = path.join(dir, 'input');
    try {
        await writeFile(input, bytes);
        const info = await magickIdentify({ exe, input, cwd: dir, signal });
        if ((!normalized && (info.width !== width || info.height !== height))
            || !info.width || !info.height || originalWidth > width || originalHeight > height) return bytes;
        const cropWidth = normalized ? Math.round((info.width * originalWidth) / width) : originalWidth;
        const cropHeight = normalized ? Math.round((info.height * originalHeight) / height) : originalHeight;
        if (!cropWidth || !cropHeight || cropWidth > info.width || cropHeight > info.height) return bytes;
        const output = path.join(dir, `unpadded.${info.format.toLowerCase() || 'png'}`);
        await magickRun(exe, [input, '-crop', `${cropWidth}x${cropHeight}+0+0`, '+repage', output], { cwd: dir, signal });
        return await readFile(output);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
