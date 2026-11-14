/**
 * @file src/access/native.js
 * @module access/native
 * @purpose The default backend of the access: the disk and the processes of Node.js.
 *
 *   This is the backend of every package that has no other one. It talks to the disk with
 *   `node:fs/promises` and runs the programs with `node:child_process` — without a shell,
 *   so the arguments of the model never become a command line.
 *
 * @depends node:fs/promises, node:child_process, node:path
 * @usedBy access/index, agent/paths
 * @exports createNativeFileSystem, createNativeExecutor, createNativeBackend
 * @ai.tags filesystem, exec, access
 * @ai.hint io
 */

import path from 'node:path';
import { readFile, writeFile, readdir, stat, lstat, realpath, unlink, mkdir, rename, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/**
 * The state of a path in the shape the facade expects.
 *
 * Node.js gives the methods (`isDirectory()`), and the facade of the access reads the
 * properties (`isDirectory`): the backend translates, so every backend of the library
 * answers in one shape.
 * @param {object} info the answer of Node.js
 * @returns {object}
 * @ai.hint pure
 */
function state(info) {
    if (!info) return null;
    return {
        size: Number.isFinite(info.size) ? info.size : 0,
        isDirectory: Boolean(info.isDirectory()),
        isFile: Boolean(info.isFile()),
        isSymbolicLink: Boolean(info.isSymbolicLink()),
        mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0,
    };
}

/**
 * The backend of the file system of Node.js.
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createNativeFileSystem() {
    return {
        /**
         * @param {string} target
         * @returns {Promise<Uint8Array>}
         */
        readFile: (target) => readFile(target),
        /**
         * @param {string} target
         * @param {Uint8Array} bytes
         * @returns {Promise<void>}
         */
        writeFile: (target, bytes) => writeFile(target, bytes),
        /**
         * @param {string} target
         * @returns {Promise<{ name: string, isDirectory: boolean, isFile: boolean, isSymbolicLink: boolean, size: number }[]>}
         */
        readdir: async (target) => {
            const items = await readdir(target, { withFileTypes: true });
            const out = [];
            for (const item of items) {
                let size = 0;
                if (item.isFile()) {
                    size = await stat(path.join(target, item.name)).then((info) => info.size).catch(() => 0);
                }
                out.push({
                    name: item.name,
                    isDirectory: item.isDirectory(),
                    isFile: item.isFile(),
                    isSymbolicLink: item.isSymbolicLink(),
                    size,
                });
            }
            return out;
        },
        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        stat: async (target) => state(await stat(target).catch(() => null)),
        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        lstat: async (target) => state(await lstat(target).catch(() => null)),
        /**
         * @param {string} target
         * @returns {Promise<string>}
         */
        realpath: (target) => realpath(target),
        /**
         * @param {string} target
         * @returns {Promise<void>}
         */
        unlink: (target) => unlink(target),
        /**
         * @param {string} target
         * @param {{ recursive?: boolean }} options
         * @returns {Promise<string|undefined>}
         */
        mkdir: (target, options) => mkdir(target, options),
        /**
         * @param {string} from
         * @param {string} to
         * @returns {Promise<void>}
         */
        rename: (from, to) => rename(from, to),
        /**
         * Copy a file or a tree.
         * @param {string} from
         * @param {string} to
         * @param {{ recursive?: boolean, force?: boolean, errorOnExist?: boolean }} [options]
         * @returns {Promise<void>}
         */
        copy: (from, to, options = {}) => cp(from, to, {
            recursive: true,
            dereference: false,
            force: false,
            errorOnExist: true,
            ...options,
        }),
    };
}

/**
 * The backend of the commands of Node.js.
 *
 * The program is started without a shell: the arguments are the arguments, and nothing
 * else may reach the command line.
 *
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createNativeExecutor() {
    return {
        /**
         * @param {string} command
         * @param {string[]} args
         * @param {{ cwd?: string, timeoutMs?: number, env?: object|null, signal?: AbortSignal|null }} options
         * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
         */
        run: (command, args, { cwd, timeoutMs = 180_000, env = null, signal = null } = {}) => new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(command, args, {
                    cwd,
                    env: env ?? process.env,
                    shell: false,
                    stdin: 'ignore',
                    windowsHide: true,
                });
            } catch (error) {
                reject(error);
                return;
            }
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let settled = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
            }, timeoutMs);
            timer.unref?.();
            const onAbort = () => {
                timedOut = false;
                child.kill();
            };
            signal?.addEventListener?.('abort', onAbort, { once: true });
            child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
            child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
            child.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
                reject(error);
            });
            child.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', onAbort);
                resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr, timedOut });
            });
        }),
    };
}

/**
 * Both backends of Node.js in one object.
 * @returns {{ fs: object, exec: object }}
 * @exports
 * @ai.hint pure
 */
export function createNativeBackend() {
    return { fs: createNativeFileSystem(), exec: createNativeExecutor() };
}
