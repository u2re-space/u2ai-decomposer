/**
 * @file src/image/magick-cli.js
 * @module image/magick-cli
 * @purpose The free command line of ImageMagick: the arguments of the model, the rules that keep
 *          them inside the run, and the run itself.
 *
 *   The tools of the house are narrow on purpose: a crop, a split, a projection. But a picture is
 *   a wide thing, and there are operations that no narrow tool covers: `-deskew` straightens a
 *   picture that was shot at an angle, `-distort Perspective` puts a quadrilateral back into a
 *   rectangle, `-trim` cuts the frame away. So the model is given the command line of ImageMagick
 *   itself, with the rules of the house around it.
 *
 *   The rules are three, and they are the rules of every tool of the house:
 *
 *   1. the command is started without a shell, with an array of arguments — a path with a space
 *      or a quote in it cannot become a second command;
 *   2. every path of the command stays inside the root of the run, and the file that is written
 *      lands in a directory the stage opened for writing;
 *   3. the protocols that read from the network or run a script are refused — the run works on
 *      the files of the run and on nothing else.
 *
 * @depends node:child_process, node:util, node:path, image/magick
 * @usedBy agent/tools (magick)
 * @exports parseMagickArgs, forbiddenMagickArg, magickOutputFile, runMagick, MAGICK_TIMEOUT_MS
 * @ai.tags imagemagick, cli, sandbox
 * @ai.hint io
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectMagick } from './magick.js';

const execFileAsync = promisify(execFile);

/** How long a command of the model may run. */
export const MAGICK_TIMEOUT_MS = 60_000;

/** The extensions of the files ImageMagick writes. */
const OUTPUT_EXTENSION = /\.(?:png|jpg|jpeg|webp|gif|tif|tiff|bmp|avif|heic|jp2|jxl|pnm|pgm|ppm|tga|ico|miff|info|txt|json|jsonl|csv)$/i;

/**
 * The protocols of ImageMagick that are refused.
 *
 * A protocol is a prefix with a colon: `msl:` runs a script, `http:` reads from the network,
 * `file:` names a file outside of the run, `label:` and `text:` are pictures that do not exist.
 * The harmless ones stay: `xc:` is a canvas of one colour, `gradient:` a gradient, `png:` a
 * setting of the format — a setting is not a protocol.
 */
const FORBIDDEN_PROTOCOL = /^(?:msl|ephemeral|https?|ftps?|file|fd|data|inline|label|text|show|histogram|histo|json|jsonl|pattern|tile|canvas|clip|clip-path|profile|mask|mpri|vid):/i;

/** A Windows drive is a path, not a protocol. */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

/**
 * The arguments of the command line, whatever shape they arrive in.
 *
 * An array is taken as it is. A string is split on the spaces, and a part in double quotes stays
 * one argument — the quoting of the command line of ImageMagick, without the shell.
 * @param {string[]|string|null|undefined} value the arguments of the model
 * @returns {string[]} the arguments, without the word "magick"
 * @exports
 * @ai.hint pure
 */
export function parseMagickArgs(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item ?? '').trim())
            .filter((item) => item.length > 0);
    }
    const text = String(value ?? '').trim();
    if (!text) return [];
    const out = [];
    let current = '';
    let quoted = false;
    let started = false;
    for (const char of text) {
        if (char === '"') {
            quoted = !quoted;
            started = true;
            continue;
        }
        if (!quoted && /\s/.test(char)) {
            if (started) {
                out.push(current);
                current = '';
                started = false;
            }
            continue;
        }
        current += char;
        started = true;
    }
    if (started) out.push(current);
    return out;
}

/**
 * The reason why an argument of the command line is refused, or null when it is allowed.
 *
 * Three kinds of arguments are refused: the list of the arguments in a file (`@file`), the
 * protocols that read from the network or run a script (`msl:`, `ephemeral:`, `http:`), and the
 * operators that write a second file or read a script of their own (`-write`, `-script`).
 * @param {string} arg one argument of the command line
 * @returns {string|null} the reason, or null when the argument is allowed
 * @exports
 * @ai.hint pure
 */
export function forbiddenMagickArg(arg) {
    const text = String(arg ?? '');
    if (!text) return null;
    if (text.startsWith('@')) {
        return 'a list of arguments in a file (@file) is not allowed';
    }
    if (!WINDOWS_DRIVE.test(text) && FORBIDDEN_PROTOCOL.test(text)) {
        return `the protocol of ImageMagick is not allowed: ${text}`;
    }
    const option = text.toLowerCase();
    if (option === '-write' || option === '-script') {
        return `the operator ${text} is not allowed`;
    }
    return null;
}

/**
 * The file the command writes, if it names one.
 *
 * The last argument of a command of ImageMagick is the file that is written; the arguments
 * before it are the pictures that are read and the options. The name is a guess, and a guess is
 * enough: the file is checked against the directories the stage opened, and a wrong guess only
 * means that the check was not made.
 * @param {string[]} args the arguments of the command line
 * @returns {string|null} the name of the file, or null when the command writes no file
 * @exports
 * @ai.hint pure
 */
export function magickOutputFile(args) {
    const list = Array.isArray(args) ? args : [];
    const last = list.length ? String(list.at(-1) ?? '') : '';
    if (!last || last.startsWith('-')) return null;
    return OUTPUT_EXTENSION.test(last) ? last : null;
}

/**
 * Run one command of ImageMagick and answer with what it said.
 *
 * The command is started without a shell, so nothing in the arguments can become a second
 * command. A command that fails is not an error of the run: the exit code and the words of
 * stderr are the answer, and the model reads them.
 * @param {{ args: string[], cwd: string, exe?: string|null, timeoutMs?: number,
 *   signal?: AbortSignal|null }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 * @exports
 * @ai.hint io
 */
export async function runMagick({ args, cwd, exe = null, timeoutMs = MAGICK_TIMEOUT_MS, signal = null }) {
    const binary = exe || await detectMagick();
    if (!binary) {
        return { code: 127, stdout: '', stderr: 'ImageMagick is not installed on this machine.' };
    }
    const options = {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        signal: signal ?? undefined,
    };
    try {
        const { stdout, stderr } = await execFileAsync(binary, args, options);
        return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        return {
            code: Number.isInteger(error?.code) ? error.code : 1,
            stdout: String(error?.stdout ?? ''),
            stderr: String(error?.stderr || error?.message || ''),
        };
    }
}

/**
 * The name of a file of the run, as the model sees it.
 * @param {string} root the root of the run
 * @param {string} name the name of the file
 * @returns {string} the name, relative to the root, with forward slashes
 * @exports
 * @ai.hint pure
 */
export function magickRelative(root, name) {
    return path.relative(root, path.resolve(root, name)).split(path.sep).join('/');
}
