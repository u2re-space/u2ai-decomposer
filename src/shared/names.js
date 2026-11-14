/**
 * @file src/shared/names.js
 * @module shared/names
 * @purpose The names of the files and of the screens.
 * @exports screenNameOf
 * @ai.tags names
 * @ai.hint pure
 */

import path from 'node:path';
import { toPosix } from '../agent/paths.js';

/**
 * The name of a screen, read from the name of its file: `01-home.png` is the screen `home`.
 * @param {string} rel the path of the file
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function screenNameOf(rel) {
    const base = path.basename(toPosix(rel));
    const withoutExt = base.replace(/\.[^.]+$/, '');
    return withoutExt.replace(/^\d+[-_]/, '') || withoutExt || 'screen';
}
