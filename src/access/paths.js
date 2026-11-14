/**
 * @file src/access/paths.js
 * @module access/paths
 * @purpose The rules of the paths: the model names a path, the access decides whether it may
 *          be touched.
 *
 *   Three rules live here, and they live here only:
 *
 *   1. a path may not leave the root of the run — neither through `..` nor through a
 *      symbolic link;
 *   2. the secret files and the secret directories are never accessible;
 *   3. the read-only directories may be read, but never written.
 *
 *   The rules do not know how the disk is reached: the caller gives the `lstat` and the
 *   `realpath` of its backend, so the same rules hold for a native disk, for a memory disk
 *   and for a remote one.
 *
 * @depends node:path, node:fs/promises
 * @usedBy access/index, agent/paths
 * @exports PROTECTED_FILES, FORBIDDEN_DIRS, READ_ONLY_DIRS, NOISY_DIRS, DEFAULT_MESSAGES,
 *          isProtectedFileName, isForbiddenDirName, isReadOnlyDirName, toPosix, isInside,
 *          resolveInside, createPathAccess
 * @ai.tags paths, sandbox, access
 * @ai.hint pure
 */

import path from 'node:path';
import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises';

/** Names that are never readable or writable: the secrets and the keys. */
export const PROTECTED_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

/** The directories that are never accessible at all. */
export const FORBIDDEN_DIRS = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;

/** The directories that may be read, but never written. */
export const READ_ONLY_DIRS = /^(?:\.git|node_modules)$/i;

/** The directories that are skipped by the listing and the search. */
export const NOISY_DIRS = /^(?:\.git|node_modules|\.hg|\.svn|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__|target|\.ai-agent|\.ai-serve|\.backup)$/i;

/**
 * The words of the refusals.
 *
 * A package may speak in its own language: the messages are a parameter, the rules are
 * not. Every message is a function, and every one of them may be replaced.
 * @type {Readonly<{ outside: Function, secret: Function, denied: Function, readOnly: Function, symlink: Function }>}
 * @exports
 * @ai.hint pure
 */
export const DEFAULT_MESSAGES = Object.freeze({
    outside: (relative) => `The path is outside the working directory: ${relative}`,
    secret: (rel) => `The file with the secret is not accessible: ${rel}`,
    denied: (rel) => `The access is denied: ${rel}`,
    readOnly: (segment, rel) => `The write into ${segment} is denied: ${rel}`,
    symlink: (rel) => `The path through a symbolic link leaves the working directory: ${rel}`,
});

/**
 * Whether the name is a secret or a key file.
 * @param {string} name the name of the file, not a path
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isProtectedFileName(name) {
    return PROTECTED_FILES.test(String(name ?? ''));
}

/**
 * Whether the name is a directory the model must never enter.
 * @param {string} name
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isForbiddenDirName(name) {
    return FORBIDDEN_DIRS.test(String(name ?? ''));
}

/**
 * Whether the name is a directory that may be read, but never written.
 * @param {string} name
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isReadOnlyDirName(name) {
    return READ_ONLY_DIRS.test(String(name ?? ''));
}

/**
 * Rewrite a relative path with forward slashes.
 * @param {string} relative
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toPosix(relative) {
    return String(relative ?? '').split(path.sep).join('/');
}

/**
 * Whether the candidate is the root itself or a path under it.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolve a path of the model into an absolute path inside the root.
 *
 * The escape is checked twice: once for the written path (`..`), and once for the real
 * path of the deepest existing part, so a symbolic link cannot lead out of the root.
 *
 * @param {string} root the absolute root of the run
 * @param {string} relative the path of the model
 * @param {{ forWrite?: boolean, allowRoot?: boolean,
 *           lstat?: (path: string) => Promise<unknown>,
 *           realpath?: (path: string) => Promise<string> }} [options]
 * @returns {Promise<{ abs: string, rel: string }>} the absolute path and the POSIX path
 *   relative to the root
 * @exports
 * @ai.hint io
 */
export async function resolveInside(root, relative, {
    forWrite = false,
    allowRoot = true,
    lstat = nodeLstat,
    realpath = nodeRealpath,
    messages = {},
} = {}) {
    if (typeof relative !== 'string') throw new Error('The path must be a string.');
    if (relative.includes('\0')) throw new Error('The path contains a NUL.');
    const words = { ...DEFAULT_MESSAGES, ...(messages ?? {}) };
    const base = path.resolve(String(root));
    const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
    const abs = path.resolve(base, cleaned);
    if (!isInside(base, abs)) throw new Error(words.outside(relative));
    const rel = toPosix(path.relative(base, abs));
    if (rel === '' && !allowRoot) throw new Error('A path to a file is needed, not to the root.');
    const segments = rel ? rel.split('/') : [];
    for (const [index, segment] of segments.entries()) {
        if (FORBIDDEN_DIRS.test(segment)) throw new Error(words.denied(rel));
        if (index === segments.length - 1 && PROTECTED_FILES.test(segment)) throw new Error(words.secret(rel));
        if (forWrite && READ_ONLY_DIRS.test(segment)) throw new Error(words.readOnly(segment, rel));
    }
    if (lstat && realpath) {
        let probe = abs;
        for (;;) {
            // The root itself is trusted: it is the place the user gave to the run.
            if (probe === base) break;
            const info = await lstat(probe).catch(() => null);
            if (info) {
                const real = await realpath(probe).catch(() => probe);
                const realRoot = await realpath(base).catch(() => base);
                if (!isInside(realRoot, real)) throw new Error(words.symlink(rel));
                break;
            }
            const parent = path.dirname(probe);
            if (parent === probe) break;
            probe = parent;
        }
    }
    return { abs, rel: rel || '.' };
}

/**
 * The access of one root: the root itself and the resolver of the paths.
 *
 * @param {{ root: string, lstat?: Function, realpath?: Function }} options
 * @returns {{ root: string, resolve: (relative: string, options?: object) => Promise<{ abs: string, rel: string }> }}
 * @exports
 * @ai.hint pure
 */
export function createPathAccess({ root, lstat = null, realpath = null } = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    return {
        root: base,
        /**
         * @param {string} relative
         * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
         * @returns {Promise<{ abs: string, rel: string }>}
         */
        resolve: (relative, options = {}) => resolveInside(base, relative, {
            ...options,
            ...(typeof options.lstat === 'function' || typeof lstat === 'function'
                ? { lstat: options.lstat ?? lstat }
                : {}),
            ...(typeof options.realpath === 'function' || typeof realpath === 'function'
                ? { realpath: options.realpath ?? realpath }
                : {}),
        }),
    };
}
