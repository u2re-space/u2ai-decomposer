/**
 * @file src/image/raster.js
 * @module image/raster
 * @purpose Local raster operations: sharp→canvas→magick fallback for crop, patch, compare, info, pad.
 * @depends node:path, node:fs/promises
 * @exports rasterEngine, rasterInfo, rasterCrop, rasterPatch, decodeRgba, rasterPadImageBytes, rasterCompare
 * @ai.tags sharp, canvas, magick, raster
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

/** @type {string|null} */
let _sharp = null;
/** @type {string|null} */
let _canvas = null;

/**
 * Detect raster engine from config: auto | sharp | canvas | magick.
 * @param {string} engine
 * @returns {Promise<string>}
 */
async function detectEngine(engine = 'auto') {
    if (engine !== 'auto') return engine;
    try { await import('sharp'); return 'sharp'; } catch {}
    try { await import('canvas'); return 'canvas'; } catch {}
    return 'magick';
}

/**
 * Load sharp library.
 * @returns {Promise<object|null>}
 */
async function sharpLib() {
    if (_sharp === null) {
        try { _sharp = (await import('sharp')).default ?? await import('sharp'); }
        catch { _sharp = false; }
    }
    return _sharp || null;
}

/**
 * Load canvas library.
 * @returns {Promise<object|null>}
 */
async function canvasLib() {
    if (_canvas === null) {
        try { _canvas = await import('canvas'); }
        catch { _canvas = false; }
    }
    return _canvas || null;
}

/**
 * Read image info (width, height, format) via raster engine.
 * @param {string} imagePath
 * @param {{ cwd?: string, engine?: string }} [opts]
 * @returns {Promise<{width:number,height:number,format?:string}>}
 */
export async function rasterInfo(imagePath, { cwd, engine = 'auto' } = {}) {
    const abs = path.resolve(cwd ?? process.cwd(), imagePath);
    const e = await detectEngine(engine);

    if (e === 'sharp') {
        const sharp = await sharpLib();
        if (sharp) {
            const meta = await sharp.abs ? sharp(abs).metadata() : null;
            if (meta?.width && meta?.height) return { width: meta.width, height: meta.height, format: meta.format };
        }
    }

    // Fallback: try canvas, then raw bytes sniff.
    const canvas = await canvasLib();
    if (canvas && canvas.loadImage) {
        try {
            const img = canvas.loadImage(abs);
            return { width: img.width, height: img.height };
        } catch {}
    }

    // Last resort: try to identify via sharp.
    const s = await sharpLib();
    if (s) {
        const meta = await s.default(abs).metadata();
        return { width: meta.width, height: meta.height, format: meta.format };
    }

    throw new Error(`Cannot read image info: ${imagePath}`);
}

/**
 * Crop an image to a rectangle.
 * @param {{ input: string, output: string, x: number, y: number, width: number, height: number, cwd?: string, signal?: AbortSignal, engine?: string }} opts
 * @returns {Promise<Buffer>}
 */
export async function rasterCrop({ input, output, x, y, width, height, cwd, signal, engine = 'auto' }) {
    const e = await detectEngine(engine);
    const absIn = path.resolve(cwd ?? process.cwd(), input);
    const absOut = path.resolve(cwd ?? process.cwd(), output);
    await mkdir(path.dirname(absOut), { recursive: true });

    if (e === 'sharp') {
        const sharp = await sharpLib();
        await sharp.default(absIn).extract({ left: x, top: y, width, height }).toFile(absOut);
        return await readFile(absOut);
    }

    // Canvas fallback.
    const canvas = await canvasLib();
    if (canvas && canvas.loadImage && canvas.createCanvas) {
        const src = canvas.loadImage(absIn);
        const dst = canvas.createCanvas(width, height);
        const ctx = dst.getContext('2d');
        ctx.drawImage(src, x, y, width, height, 0, 0, width, height);
        const buf = dst.toBuffer('PNG');
        await writeFile(absOut, buf);
        return buf;
    }

    // Magick fallback.
    const cmd = `magick "${absIn}" -crop ${width}x${height}+${x}+${y} "${absOut}"`;
    const { execFile } = await import('node:child_process');
    await new Promise((ok, fail) => execFile(cmd, { shell: true }, (err) => err ? fail(err) : ok()));
    return await readFile(absOut);
}

/**
 * Patch (stitch) a source image with a patch at given coordinates.
 * @param {{ input: string, patch: string, output: string, x: number, y: number, width: number, height: number, cwd?: string, engine?: string }} opts
 * @returns {Promise<{ resized: boolean, grown: boolean, box: {x:number,y:number,width:number,height:number} }>}
 */
export async function rasterPatch({ input, patch, output, x, y, width, height, cwd, engine = 'auto' }) {
    const absOut = path.resolve(cwd ?? process.cwd(), output);
    await mkdir(path.dirname(absOut), { recursive: true });

    const e = await detectEngine(engine);

    if (e === 'sharp') {
        const sharp = await sharpLib();
        const base = sharp.default(input);
        const patchImg = sharp.default(patch);
        await base.composite([{ input: abs(patch), left: x, top: y }]).toFile(absOut);
        return { resized: false, grown: false, box: { x, y, width, height } };
    }

    // Canvas fallback.
    const canvas = await canvasLib();
    if (canvas && canvas.loadImage && canvas.createCanvas) {
        const src = canvas.loadImage(input);
        const dst = canvas.createCanvas(src.width, src.height);
        const ctx = dst.getContext('2d');
        ctx.drawImage(src, 0, 0);
        const p = canvas.loadImage(patch);
        ctx.drawImage(p, x, y);
        const buf = dst.toBuffer('PNG');
        await writeFile(absOut, buf);
        return { resized: false, grown: false, box: { x, y, width, height } };
    }

    // Magick fallback.
    const absOut2 = `${absOut}+0+0`;
    const cmd = `magick "${input}" "${patch}" -geometry +${x}+${y} -compose over -composite "${absOut}"`;
    const { execFile } = await import('node:child_process');
    await new Promise((ok, fail) => execFile(cmd, { shell: true }, (err) => err ? fail(err) : ok()));
    return { resized: false, grown: false, box: { x, y, width, height } };
}

/**
 * Decode image bytes to raw RGBA buffer.
 * @param {Buffer} bytes
 * @param {{ engine?: string }} [opts]
 * @returns {Promise<{width:number,height:number,data:Buffer}>}
 */
export async function decodeRgba(bytes, { engine = 'auto' } = {}) {
    const e = await detectEngine(engine);
    if (e === 'sharp') {
        const sharp = await sharpLib();
        const { data, info } = await sharp.default(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { width: info.width, height: info.height, data };
    }

    // Canvas fallback.
    const canvas = await canvasLib();
    if (canvas && canvas.loadImage) {
        const img = canvas.loadImage(bytes);
        const c = canvas.createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
        return { width, height, data: Buffer.from(data) };
    }

    throw new Error('Cannot decode RGBA: no raster engine available');
}

/**
 * Pad image bytes to a target size (transparent padding on right/bottom).
 * @param {{ bytes: Buffer, engine: string, targetWidth: number, targetHeight: number }} opts
 * @returns {Promise<{ bytes: Buffer, width: number, height: number, padded: boolean }>}
 */
export async function rasterPadImageBytes({ bytes, engine, targetWidth, targetHeight }) {
    const info = await decodeRgba(bytes, { engine });
    const { width: srcW, height: srcH } = info;
    if (targetWidth <= srcW && targetHeight <= srcH) return { bytes, width: srcW, height: srcH, padded: false };

    const padWidth = Math.max(0, targetWidth - srcW);
    const padHeight = Math.max(0, targetHeight - srcH);

    // Create padded canvas.
    const canvas = await canvasLib();
    if (canvas && canvas.createCanvas) {
        const c = canvas.createCanvas(targetWidth, targetHeight);
        const ctx = c.getContext('2d');
        // Copy source.
        const src = canvas.loadImage(bytes);
        ctx.drawImage(src, 0, 0);
        // Fill padded area transparent.
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        // Put source back.
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(src, 0, 0);
        const buf = c.toBuffer('PNG');
        return { bytes: buf, width: targetWidth, height: targetHeight, padded: true };
    }

    // Fallback: sharp.
    const sharp = await sharpLib();
    if (sharp) {
        const padded = await sharp.default(bytes)
            .resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
            .toBuffer({ resolveWithObject: true });
        return { bytes: padded, width: targetWidth, height: targetHeight, padded: true };
    }

    throw new Error('Cannot pad image: no raster engine available');
}

/**
 * Compare two images pixel-by-pixel, return delta stats.
 * @param {{ before: Buffer, after: Buffer, width: number, height: number }} opts
 * @returns {{ meanDelta: number, changedShare: number }}
 */
export async function rasterCompare({ before, after, width, height }) {
    const [b, a] = await Promise.all([
        decodeRgba(before),
        decodeRgba(after),
    ]);

    let sum = 0, changed = 0, seen = 0;
    for (let i = 0; i < b.data.length; i += 4) {
        const delta = Math.abs(b.data[i] - a.data[i])
                    + Math.abs(b.data[i+1] - a.data[i+1])
                    + Math.abs(b.data[i+2] - a.data[i+2]);
        sum += delta / 3;
        if (delta > 12) changed++;
        seen++;
    }
    return {
        meanDelta: seen ? sum / seen : Infinity,
        changedShare: seen ? changed / seen : 1,
    };
}