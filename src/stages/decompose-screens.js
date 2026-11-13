/**
 * @file src/stages/decompose-screens.js
 * @module stages/decompose-screens
 * @purpose The inline mode of the decompose stage: plan the rectangles the role named and cut
 *          them out of the source pixels.
 *
 *   The model answers with the rectangle of every screen in the picture it saw. The harness cuts
 *   those pixels itself, so nothing is generated and nothing is re-drawn: the screen in the file
 *   is the screen in the source, byte for byte.
 *
 * @depends node:path, image/crop
 * @exports planScreens, cropScreens, screenFileName
 * @ai.tags decomposition, screens, crop, inline
 * @ai.hint keep
 */
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { clampRect, cropRect } from '../image/crop.js';
import { rasterInfo } from '../image/raster.js';
import { toPosix } from '../agent/paths.js';

/**
 * The file name of one screen: its order and a slug of its name.
 * @param {number} index zero-based order of the screen
 * @param {string} name the name the role gave the screen
 * @returns {string}
 * @ai.hint pure
 */
export function screenFileName(index, name) {
    const slug = String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'screen';
    return `${String(index + 1).padStart(2, '0')}-${slug}.png`;
}

/**
 * Turn the rectangles of the answer into the rectangles that will be cut.
 *
 * The rects are in the pixels of the picture the model saw; the crop happens in the pixels of the
 * source, so the coordinates are mapped back through the scale of the model-bound copy first.
 * The caps of the stage are applied here: the number of rects, the total area of the crop and
 * the smallest side a screen may have.
 * @param {{ decomposition: object, frame: { width: number, height: number },
 *   source: { width: number, height: number }, limits?: object }} params
 * @returns {{ accepted: object[], dropped: Array<{ name: string, reason: string }> }}
 * @ai.hint pure
 */
export function planScreens({ decomposition, frame, source, limits = {} } = {}) {
    const maxRects = Number.isSafeInteger(limits.maxRects) ? limits.maxRects : 24;
    const maxInlinePixels = Number.isSafeInteger(limits.maxInlinePixels) ? limits.maxInlinePixels : 64 * 1_000_000;
    const minScreenSide = Number.isSafeInteger(limits.minScreenSide) ? limits.minScreenSide : 48;
    const scaleX = frame?.width ? source.width / frame.width : 1;
    const scaleY = frame?.height ? source.height / frame.height : 1;

    const accepted = [];
    const dropped = [];
    let usedPixels = 0;
    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];

    for (const [index, screen] of screens.entries()) {
        const name = String(screen?.name ?? '').trim() || `screen-${index + 1}`;
        const rect = screen?.rect;
        if (!rect || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))) {
            dropped.push({ name, reason: 'no rectangle in the answer' });
            continue;
        }
        if (accepted.length >= maxRects) {
            dropped.push({ name, reason: `more than ${maxRects} rectangles` });
            continue;
        }
        const scaled = {
            x: Math.round(Number(rect.x ?? 0) * scaleX),
            y: Math.round(Number(rect.y ?? 0) * scaleY),
            width: Math.round(Number(rect.width) * scaleX),
            height: Math.round(Number(rect.height) * scaleY),
        };
        const box = clampRect(scaled, source);
        if (box.width < minScreenSide || box.height < minScreenSide) {
            dropped.push({ name, reason: `smaller than ${minScreenSide} px on a side` });
            continue;
        }
        const area = box.width * box.height;
        if (usedPixels + area > maxInlinePixels) {
            dropped.push({ name, reason: `the crop budget of ${maxInlinePixels} pixels is used up` });
            continue;
        }
        usedPixels += area;
        accepted.push({
            index,
            name,
            screen,
            rect: box,
            source: String(screen?.source ?? '').trim(),
        });
    }

    return { accepted, dropped };
}

/**
 * Cut the planned screens out of the source picture.
 *
 * With `skipExisting` a file that is already there is not cut again: the role may have written it
 * under another name than the screen carries, and overwriting it would throw away its work. The
 * file that is already there is reported as the file of the screen.
 * @param {{ root: string, screensDir: string, source: string, accepted: object[], engine?: string,
 *   skipExisting?: boolean }} params
 * @returns {Promise<{ files: object[], warnings: string[] }>}
 */
export async function cropScreens({ root, screensDir, source, accepted, engine = 'auto', skipExisting = false } = {}) {
    const files = [];
    const warnings = [];
    for (const item of accepted) {
        const name = screenFileName(item.index, item.name);
        const output = path.join(screensDir, name);
        if (skipExisting) {
            const there = await stat(output).catch(() => null);
            if (there?.isFile()) {
                const info = await rasterInfo(output, { cwd: root, engine }).catch(() => null);
                files.push({
                    rel: toPosix(path.relative(root, output)),
                    abs: output,
                    bytes: there.size,
                    width: info?.width ?? null,
                    height: info?.height ?? null,
                    screen: item.name,
                    kind: 'crop',
                    source: item.source,
                    note: 'the file was already there',
                });
                continue;
            }
        }
        try {
            const result = await cropRect({
                input: source,
                output,
                rect: item.rect,
                cwd: root,
                engine,
            });
            const abs = path.resolve(output);
            files.push({
                rel: toPosix(path.relative(root, abs)),
                abs,
                bytes: result.bytes,
                width: result.width,
                height: result.height,
                screen: item.name,
                kind: 'crop',
                source: item.source,
                note: '',
            });
        } catch (error) {
            warnings.push(`Screen ${item.name} could not be cut: ${error?.message ?? error}`);
        }
    }
    return { files, warnings };
}
