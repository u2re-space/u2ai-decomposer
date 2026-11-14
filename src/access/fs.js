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
 *     readdir(abs) -> [{ name, isDirectory, isFile, isSymbolicLink, size }],
 *     stat(abs) -> { size, isDirectory, isFile, isSymbolicLink, mtimeMs } | null,
 *     lstat(abs) -> { size, isDirectory, isFile, isSymbolicLink, mtimeMs } | null,
 *     realpath(abs) -> string,
 *     unlink(abs),
 *     mkdir(abs, { recursive }),
 *     rename(abs, abs),
 *     copy(abs, abs, { recursive, force }),
 *   }
 *   ```
 *
 *   The state of a path is a plain object with the properties, not the methods of Node.js:
 *   every backend answers in one shape, and the facade never asks the backend how a path is.
 *
 * @depends node:path, access/paths
 * @usedBy access/index, agent/paths
 * @exports ACCESS_LIMITS, formatBytes, createFileSystem
 * @ai.tags filesystem, access
 * @ai.hint io
 */

import path from 'node:path';
import { resolveInside, isInside, isForbiddenDirName, isProtectedFileName, NOISY_DIRS, toPosix } from './paths.js';

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
 * A size in bytes as a short text: `1.2 KB`, `3.4 MB`.
 *
 * The library keeps this text in itself: it is copied into five packages, and it must not
 * depend on the modules of any of them.
 * @param {number} bytes
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '0 B';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

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
     * The nearest existing directory at or above the path.
     * @param {string} rel the POSIX path relative to the root
     * @returns {Promise<string|null>}
     */
    const nearestDirectory = async (rel) => {
        if (typeof backend.stat !== 'function') return null;
        const parts = String(rel ?? '').split('/').filter((part) => part && part !== '.');
        while (parts.length) {
            parts.pop();
            const info = await backend.stat(path.join(base, ...parts));
            if (info?.isDirectory) return parts.join('/') || '.';
        }
        return null;
    };

    /**
     * The listing of the files: the tree of a directory as the model reads it.
     *
     * The noisy folders (`node_modules`, `.git`, `dist`) are marked and not opened, the
     * dot-files are hidden unless they are asked for, and the sizes are in the text. A path
     * that does not exist yet lists the nearest existing parent instead of failing: a probe
     * of a directory that `write_file` will create still answers with a tree.
     * @param {string} relative
     * @param {{ depth?: number, limit?: number, includeHidden?: boolean }} [options]
     * @returns {Promise<{ path: string, text: string, entries: object[], count: number, truncated: boolean, missing?: string }>}
     */
    const listFiles = async (relative = '.', { depth = 2, limit = rules.listEntries, includeHidden = false } = {}) => {
        const { abs, rel } = await resolve(relative);
        const info = typeof backend.stat === 'function' ? await backend.stat(abs) : null;
        if (!info) {
            const parent = await nearestDirectory(rel);
            if (!parent) throw new Error(`The directory is not found: ${relative}`);
            const listing = await listFiles(parent, { depth, limit, includeHidden });
            const where = parent === '.' ? 'the root of the project' : `the directory ${parent}`;
            return {
                path: rel,
                text: `The directory is not found: ${rel}. write_file will create it when it writes the file. The content of ${where}:\n${listing.text}`,
                entries: listing.entries,
                count: listing.count,
                truncated: listing.truncated,
                missing: rel,
            };
        }
        if (!info.isDirectory) throw new Error(`It is not a directory: ${relative}`);
        const lines = [];
        const entries = [];
        let truncated = false;
        /**
         * List one level and go deeper until the depth is reached.
         * @param {string} directory the absolute path
         * @param {string} prefix the POSIX path of the directory
         * @param {number} level
         * @returns {Promise<void>}
         */
        const walk = async (directory, prefix, level) => {
            if (truncated) return;
            const items = await backend.readdir(directory).catch(() => []);
            const sorted = [...items].sort((a, b) => {
                const left = Boolean(a?.isDirectory);
                const right = Boolean(b?.isDirectory);
                if (left === right) return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
                return left ? -1 : 1;
            });
            for (const item of sorted) {
                const name = String(item?.name ?? '');
                if (!name) continue;
                if (!includeHidden && name.startsWith('.') && name !== '.github') continue;
                if (isForbiddenDirName(name)) continue;
                const childRel = prefix ? `${prefix}/${name}` : name;
                if (lines.length >= limit) {
                    truncated = true;
                    return;
                }
                if (item?.isDirectory) {
                    const skip = NOISY_DIRS.test(name);
                    lines.push(`${childRel}/${skip ? '  (skipped)' : ''}`);
                    entries.push({ path: childRel, type: 'directory', size: 0 });
                    if (!skip && level < depth) await walk(path.join(directory, name), childRel, level + 1);
                    continue;
                }
                const size = Number.isFinite(item?.size) ? item.size : 0;
                if (item?.isSymbolicLink) {
                    lines.push(`${childRel}  (symlink)`);
                    entries.push({ path: childRel, type: 'link', size: 0 });
                    continue;
                }
                lines.push(`${childRel}  (${formatBytes(size)})`);
                entries.push({ path: childRel, type: 'file', size });
            }
        };
        await walk(abs, rel === '.' ? '' : rel, 1);
        const note = truncated ? `\n…the list is cut (${limit} entries)` : '';
        return {
            path: rel,
            text: `${lines.join('\n') || '(empty)'}${note}`,
            entries,
            count: lines.length,
            truncated,
        };
    };

    /**
     * Copy a file or a tree.
     *
     * The rules of the paths hold for the copy as well: the source and the destination stay
     * inside the root, a secret is never copied, a symbolic link is never followed, and a
     * directory is never copied into itself. The destination must not exist, unless the
     * caller asks for the overwrite.
     * @param {string} source
     * @param {string} destination
     * @param {{ overwrite?: boolean }} [options]
     * @returns {Promise<{ source: string, destination: string, type: 'file'|'directory' }>}
     */
    const copy = async (source, destination, { overwrite = false } = {}) => {
        const from = await resolve(source, { allowRoot: false });
        const to = await resolve(destination, { forWrite: true, allowRoot: false });
        if (from.rel === '.backup' || from.rel.startsWith('.backup/')) throw new Error(`The read from .backup is denied: ${from.rel}`);
        if (to.rel === '.backup' || to.rel.startsWith('.backup/')) throw new Error(`The write into .backup is denied: ${to.rel}`);
        const info = typeof backend.lstat === 'function' ? await backend.lstat(from.abs) : null;
        if (!info) throw new Error(`The source is not found: ${source}`);
        if (info.isSymbolicLink) throw new Error(`The copy of a symbolic link is denied: ${from.rel}`);
        if (!info.isDirectory && !info.isFile) throw new Error(`The source must be a file or a directory: ${from.rel}`);
        if (info.isDirectory && isInside(from.abs, to.abs)) throw new Error('A directory cannot be copied into itself.');
        /**
         * Check the tree of the source: no secret, no forbidden directory, no symbolic link.
         * @param {string} abs
         * @param {string} rel
         * @returns {Promise<void>}
         */
        const validateTree = async (abs, rel) => {
            const current = typeof backend.lstat === 'function' ? await backend.lstat(abs) : null;
            const name = path.basename(abs);
            if (isForbiddenDirName(name)) throw new Error(`The access is denied: ${rel}`);
            if (current?.isSymbolicLink) throw new Error(`The copy of a symbolic link is denied: ${rel}`);
            if (current?.isFile && isProtectedFileName(name)) throw new Error(`The file with the secret is not accessible: ${rel}`);
            if (!current?.isDirectory) return;
            const items = await backend.readdir(abs);
            for (const item of items) {
                await validateTree(path.join(abs, String(item?.name ?? '')), `${rel}/${item?.name ?? ''}`);
            }
        };
        await validateTree(from.abs, from.rel);
        const existing = typeof backend.stat === 'function' ? await backend.stat(to.abs) : null;
        if (existing && !overwrite) throw new Error(`The path of the destination already exists: ${to.rel}`);
        if (typeof backend.mkdir === 'function') await backend.mkdir(path.dirname(to.abs), { recursive: true });
        if (typeof backend.copy !== 'function') throw new Error('The backend of the file system cannot copy.');
        await backend.copy(from.abs, to.abs, { recursive: true, force: overwrite, errorOnExist: !overwrite });
        return { source: from.rel, destination: to.rel, type: info.isDirectory ? 'directory' : 'file' };
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
        listFiles,
        copy,
        remove,
        makeDir,
        replace,
        search,
        toPosix,
    };
}
