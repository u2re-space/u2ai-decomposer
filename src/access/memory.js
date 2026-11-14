/**
 * @file src/access/memory.js
 * @module access/memory
 * @purpose An alternative backend of the access: the files live in the memory, and the
 *          commands are only recorded.
 *
 *   The backend is the proof that the access does not depend on the disk: the same rules
 *   of the paths, the same facade, another backend. It is used by the tests and by the
 *   dry runs — a plan may be checked without touching a single file.
 *
 *   The commands are recorded in `calls`, and their answers come from `answers`: a map of
 *   `command` to `{ code, stdout, stderr }`.
 *
 * @depends node:path
 * @usedBy access/index, agent/paths
 * @exports createMemoryFileSystem, createMemoryExecutor, createMemoryBackend
 * @ai.tags filesystem, exec, access, memory
 * @ai.hint io
 */

import path from 'node:path';

const encoder = new TextEncoder();

/**
 * The key of a path: the absolute path without the trailing separator.
 * @param {string} target
 * @returns {string}
 */
function keyOf(target) {
    const abs = path.resolve(String(target ?? '.'));
    return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

/**
 * The backend of the file system in the memory.
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createMemoryFileSystem() {
    /** @type {Map<string, { bytes: Uint8Array|null, isDirectory: boolean, mtimeMs: number }>} */
    const nodes = new Map();

    /**
     * The node of a path, if it is there.
     * @param {string} target
     * @returns {object|undefined}
     */
    const node = (target) => nodes.get(keyOf(target));

    /**
     * The name of a file that is not there.
     * @param {string} target
     * @returns {Error}
     */
    const missing = (target) => {
        const error = new Error(`ENOENT: no such file or directory, '${target}'`);
        error.code = 'ENOENT';
        return error;
    };

    return {
        nodes,
        /**
         * @param {string} target
         * @returns {Promise<Uint8Array>}
         */
        readFile: async (target) => {
            const found = node(target);
            if (!found || found.isDirectory || !found.bytes) throw missing(target);
            return found.bytes;
        },
        /**
         * @param {string} target
         * @param {Uint8Array} bytes
         * @returns {Promise<void>}
         */
        writeFile: async (target, bytes) => {
            nodes.set(keyOf(target), { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), isDirectory: false, mtimeMs: Date.now() });
        },
        /**
         * @param {string} target
         * @returns {Promise<{ name: string, isDirectory: boolean, isFile: boolean, size: number }[]>}
         */
        readdir: async (target) => {
            const found = node(target);
            if (!found) return [];
            if (!found.isDirectory) throw missing(target);
            const base = keyOf(target);
            const out = [];
            for (const [key, value] of nodes) {
                if (key === base) continue;
                const relative = path.relative(base, key);
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
                if (relative.includes(path.sep)) continue;
                out.push({
                    name: relative,
                    isDirectory: value.isDirectory,
                    isFile: !value.isDirectory,
                    isSymbolicLink: false,
                    size: value.bytes ? value.bytes.byteLength : 0,
                });
            }
            return out;
        },
        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        stat: async (target) => {
            const found = node(target);
            if (!found) return null;
            return {
                size: found.bytes ? found.bytes.byteLength : 0,
                isDirectory: found.isDirectory,
                isFile: !found.isDirectory,
                isSymbolicLink: false,
                mtimeMs: found.mtimeMs,
            };
        },
        /**
         * @param {string} target
         * @returns {Promise<object|null>}
         */
        lstat: async (target) => {
            const found = node(target);
            if (!found) return null;
            return {
                size: found.bytes ? found.bytes.byteLength : 0,
                isDirectory: found.isDirectory,
                isFile: !found.isDirectory,
                isSymbolicLink: false,
                mtimeMs: found.mtimeMs,
            };
        },
        /**
         * @param {string} target
         * @returns {Promise<string>}
         */
        realpath: async (target) => keyOf(target),
        /**
         * @param {string} target
         * @returns {Promise<void>}
         */
        unlink: async (target) => {
            if (!node(target)) throw missing(target);
            nodes.delete(keyOf(target));
        },
        /**
         * @param {string} target
         * @param {{ recursive?: boolean }} options
         * @returns {Promise<string|undefined>}
         */
        mkdir: async (target, { recursive = false } = {}) => {
            const abs = keyOf(target);
            if (nodes.has(abs)) return abs;
            if (!recursive) {
                nodes.set(abs, { bytes: null, isDirectory: true, mtimeMs: Date.now() });
                return abs;
            }
            // The parts are built from the root down: a drive letter is not a part of the path.
            const parts = [];
            let current = abs;
            while (current !== path.dirname(current)) {
                parts.unshift(path.basename(current));
                current = path.dirname(current);
            }
            let built = current;
            for (const part of parts) {
                built = path.join(built, part);
                if (!nodes.has(built)) nodes.set(built, { bytes: null, isDirectory: true, mtimeMs: Date.now() });
            }
            return abs;
        },
        /**
         * @param {string} from
         * @param {string} to
         * @returns {Promise<void>}
         */
        rename: async (from, to) => {
            const found = node(from);
            if (!found) throw missing(from);
            nodes.delete(keyOf(from));
            nodes.set(keyOf(to), found);
        },
        /**
         * Copy a file or a tree.
         *
         * The tree of a directory is copied with it: the nodes under the source keep their
         * names and their bytes, and the destination gets its own copy of them.
         * @param {string} from
         * @param {string} to
         * @param {{ recursive?: boolean, force?: boolean }} [options]
         * @returns {Promise<void>}
         */
        copy: async (from, to, { recursive = true, force = false } = {}) => {
            const source = keyOf(from);
            const found = node(from);
            if (!found) throw missing(from);
            const target = keyOf(to);
            if (nodes.has(target) && !force) {
                const error = new Error(`EEXIST: file already exists, '${to}'`);
                error.code = 'EEXIST';
                throw error;
            }
            const stamp = Date.now();
            nodes.set(target, { bytes: found.bytes, isDirectory: found.isDirectory, mtimeMs: stamp });
            if (!found.isDirectory || !recursive) return;
            const prefix = `${source}${path.sep}`;
            for (const [key, value] of [...nodes.entries()]) {
                if (!key.startsWith(prefix)) continue;
                const child = path.join(target, path.relative(source, key));
                nodes.set(child, { bytes: value.bytes, isDirectory: value.isDirectory, mtimeMs: stamp });
            }
        },
    };
}

/**
 * The backend of the commands in the memory: the command is recorded, not run.
 *
 * @param {{ answers?: Record<string, { code?: number, stdout?: string, stderr?: string }> }} [options]
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createMemoryExecutor({ answers = {} } = {}) {
    /** @type {{ command: string, args: string[], cwd: string }[]} */
    const calls = [];
    return {
        calls,
        /**
         * @param {string} command
         * @param {string[]} args
         * @param {{ cwd?: string, timeoutMs?: number, env?: object|null, signal?: AbortSignal|null }} options
         * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
         */
        run: async (command, args, { cwd = '', timeoutMs = 0, env = null, signal = null } = {}) => {
            calls.push({ command, args: [...(args ?? [])], cwd });
            const answer = answers[command] ?? {};
            return {
                code: Number.isInteger(answer.code) ? answer.code : 0,
                stdout: String(answer.stdout ?? ''),
                stderr: String(answer.stderr ?? ''),
                timedOut: false,
            };
        },
    };
}

/**
 * Both backends in the memory in one object.
 * @param {{ answers?: object }} [options]
 * @returns {{ fs: object, exec: object }}
 * @exports
 * @ai.hint pure
 */
export function createMemoryBackend({ answers = {} } = {}) {
    return { fs: createMemoryFileSystem(), exec: createMemoryExecutor({ answers }) };
}
