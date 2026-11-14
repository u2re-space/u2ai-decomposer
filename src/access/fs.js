/**
 * @file src/access/fs.js
 * @module access/fs
 * @purpose The files of the run, seen through a backend.
 *
 *   The module knows the shape of a file system and nothing about the disk: it asks the
 *   backend for the bytes and decides what may be done with them. The rules of the paths
 *   come from `access/paths`, so every backend obeys them.
 *
 *   The backend is a small object:
 *
 *   ```js
 *   {
 *     readFile(abs) -> Uint8Array,
 *     writeFile(abs, bytes),
 *     readdir(abs) -> [{ name, isDirectory, isFile, size }],
 *     stat(abs) -> { size, isDirectory, isFile, mtimeMs } | null,
 *     lstat(abs) -> { size, isDirectory, isFile, mtimeMs } | null,
 *     realpath(abs) -> string,
 *     unlink(abs),
 *     mkdir(abs, { recursive }),
 *     rename(abs, abs),
 *   }
 *   ```
 *
 * @depends node:path, access/paths
 * @usedBy access/index, agent/paths
 * @exports ACCESS_LIMITS, createFileSystem
 * @ai.tags filesystem, access
 * @ai.hint io
 */

import path from 'node:path';
import { resolveInside, isForbiddenDirName, isProtectedFileName, NOISY_DIRS, toPosix } from './paths.js';

/** The limits of the reads and the writes. */
export const ACCESS_LIMITS = Object.freeze({
    readBytes: 1024 * 1024,
    writeBytes: 4 * 1024 * 1024,
    listEntries: 400,
    searchMatches: 60,
    searchBytes: 1024 * 1024,
});

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * The file system of one root.
 *
 * @param {{ root: string, backend: object, limits?: object, messages?: object }} options
 * @returns {object} the facade of the files
 * @exports
 * @ai.hint io
 */
export function createFileSystem({ root, backend, limits = {}, messages = {} } = {}) {
    if (!backend || typeof backend.readFile !== 'function') {
        throw new Error('The access needs a backend of the file system.');
    }
    const base = path.resolve(String(root ?? process.cwd()));
    const rules = { ...ACCESS_LIMITS, ...(limits ?? {}) };

    /**
     * Resolve a path of the caller into an absolute path inside the root.
     * @param {string} relative
     * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
     * @returns {Promise<{ abs: string, rel: string }>}
     */
    const resolve = (relative, options = {}) => resolveInside(base, relative, {
        ...options,
        messages,
        lstat: typeof backend.lstat === 'function' ? backend.lstat : null,
        realpath: typeof backend.realpath === 'function' ? backend.realpath : null,
    });

    /**
     * Read a file as text.
     * @param {string} relative
     * @param {{ maxBytes?: number }} [options]
     * @returns {Promise<{ path: string, text: string, bytes: number, truncated: boolean }>}
     */
    const readText = async (relative, { maxBytes = rules.readBytes } = {}) => {
        const { abs, rel } = await resolve(relative, { allowRoot: false });
        const raw = await backend.readFile(abs);
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const slice = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
        return {
            path: rel,
            text: decoder.decode(slice),
            bytes: bytes.byteLength,
            truncated: bytes.byteLength > maxBytes,
        };
    };

    /**
     * Write a file as text.
     * @param {string} relative
     * @param {string} text
     * @param {{ createParents?: boolean }} [options]
     * @returns {Promise<{ path: string, bytes: number, created: boolean }>}
     */
    const writeText = async (relative, text, { createParents = true } = {}) => {
        const { abs, rel } = await resolve(relative, { forWrite: true, allowRoot: false });
        const data = encoder.encode(String(text ?? ''));
        if (data.byteLength > rules.writeBytes) {
            throw new Error(`The file is too big: ${data.byteLength} bytes.`);
        }
        const before = typeof backend.stat === 'function' ? await backend.stat(abs) : null;
        if (createParents && typeof backend.mkdir === 'function') {
            await backend.mkdir(path.dirname(abs), { recursive: true });
        }
        await backend.writeFile(abs, data);
        return { path: rel, bytes: data.byteLength, created: !before };
    };

    /**
     * The state of a path.
     * @param {string} relative
     * @returns {Promise<{ path: string, exists: boolean, type: string|null, size: number }>}
     */
    const stat = async (relative) => {
        const { abs, rel } = await resolve(relative);
        const info = typeof backend.stat === 'function' ? await backend.stat(abs) : null;
        if (!info) return { path: rel, exists: false, type: null, size: 0 };
        return {
            path: rel,
            exists: true,
            type: info.isDirectory ? 'directory' : 'file',
            size: Number.isFinite(info.size) ? info.size : 0,
        };
    };

    /**
     * Whether the path exists.
     * @param {string} relative
     * @returns {Promise<boolean>}
     */
    const exists = async (relative) => (await stat(relative)).exists;

    /**
     * The tree of a directory.
     * @param {string} relative
     * @param {{ depth?: number, limit?: number }} [options]
     * @returns {Promise<{ path: string, entries: { path: string, type: string, size: number }[] }>}
     */
    const list = async (relative = '.', { depth = 1, limit = rules.listEntries } = {}) => {
        const { abs, rel } = await resolve(relative);
        const found = [];
        /**
         * Walk one directory.
         * @param {string} directory the absolute path
         * @param {string} prefix the POSIX path of the directory
         * @param {number} level
         * @returns {Promise<void>}
         */
        const walk = async (directory, prefix, level) => {
            if (found.length >= limit) return;
            const items = await backend.readdir(directory);
            for (const item of items) {
                if (found.length >= limit) return;
                const name = String(item?.name ?? '');
                if (!name || isForbiddenDirName(name)) continue;
                if (item?.isDirectory && NOISY_DIRS.test(name)) continue;
                const child = path.join(directory, name);
                const childRel = prefix === '.' ? name : `${prefix}/${name}`;
                found.push({
                    path: childRel,
                    type: item?.isDirectory ? 'directory' : 'file',
                    size: Number.isFinite(item?.size) ? item.size : 0,
                });
                if (item?.isDirectory && level < depth) {
                    await walk(child, childRel, level + 1);
                }
            }
        };
        await walk(abs, rel === '.' ? '.' : rel, 1);
        return { path: rel, entries: found };
    };

    /**
     * Remove a file.
     * @param {string} relative
     * @returns {Promise<{ path: string, removed: boolean }>}
     */
    const remove = async (relative) => {
        const { abs, rel } = await resolve(relative, { forWrite: true, allowRoot: false });
        await backend.unlink(abs);
        return { path: rel, removed: true };
    };

    /**
     * Create a directory.
     * @param {string} relative
     * @param {{ recursive?: boolean }} [options]
     * @returns {Promise<{ path: string }>}
     */
    const makeDir = async (relative, { recursive = true } = {}) => {
        const { abs, rel } = await resolve(relative, { forWrite: true });
        await backend.mkdir(abs, { recursive });
        return { path: rel };
    };

    /**
     * Replace a text in a file.
     * @param {string} relative
     * @param {string} find
     * @param {string} replacement
     * @param {{ all?: boolean }} [options]
     * @returns {Promise<{ path: string, changed: boolean, count: number }>}
     */
    const replace = async (relative, find, replacement, { all = false } = {}) => {
        const needle = String(find ?? '');
        if (!needle) throw new Error('The text to replace is missing.');
        const read = await readText(relative);
        const source = read.text;
        const parts = all ? source.split(needle) : source.split(needle);
        if (parts.length < 2) return { path: read.path, changed: false, count: 0 };
        const joined = parts.join(String(replacement ?? ''));
        const count = parts.length - 1;
        await writeText(relative, joined);
        return { path: read.path, changed: true, count };
    };

    /**
     * Find the files whose text holds the query.
     * @param {{ query: string, path?: string, limit?: number, maxBytes?: number }} options
     * @returns {Promise<{ query: string, matches: { path: string, line: number, text: string }[] }>}
     */
    const search = async ({ query, path: relative = '.', limit = rules.searchMatches, maxBytes = rules.searchBytes } = {}) => {
        const needle = String(query ?? '').toLowerCase();
        if (!needle) throw new Error('The query is missing.');
        const tree = await list(relative, { depth: 12, limit: 2000 });
        const matches = [];
        for (const entry of tree.entries) {
            if (matches.length >= limit) break;
            if (entry.type !== 'file') continue;
            const name = path.basename(entry.path);
            if (isProtectedFileName(name)) continue;
            let text;
            try {
                text = (await readText(entry.path, { maxBytes })).text;
            } catch {
                continue;
            }
            const rows = text.split('\n');
            for (const [index, row] of rows.entries()) {
                if (matches.length >= limit) break;
                if (!row.toLowerCase().includes(needle)) continue;
                matches.push({ path: entry.path, line: index + 1, text: row.trim().slice(0, 400) });
            }
        }
        return { query: String(query ?? ''), matches };
    };

    return {
        root: base,
        resolve,
        readText,
        writeText,
        stat,
        exists,
        list,
        remove,
        makeDir,
        replace,
        search,
        toPosix,
    };
}
