/**
 * @file src/agent/paths.js
 * @module agent/paths
 * @purpose Keep model paths inside the working directory and refuse secrets and symlink escapes.
 * @depends node:path, node:fs/promises
 * @usedBy agent/tools, agent/decomposition
 * @exports toPosix, isInside, resolveInside
 * @ai.tags paths, sandbox
 * @ai.hint keep
 */
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/** Names that are never readable or writable by the model (secrets, keys). */
const PROTECTED_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

/** Directories that are never accessible at all. */
const FORBIDDEN_DIRS = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;

/** Directories the model may read but never write into. */
const READ_ONLY_DIRS = /^(?:\.git|node_modules)$/i;

/**
 * Rewrite a relative path with forward slashes.
 * @param {string} relative
 * @returns {string}
 * @ai.hint pure
 */
export function toPosix(relative) {
    return String(relative ?? '').split(path.sep).join('/');
}

/**
 * True when `candidate` is `root` or lies beneath it.
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 * @ai.hint pure
 */
export function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolve a model-supplied path to an absolute path inside `root`.
 *
 * The check runs twice: once on the literal path and once on the real path of the deepest
 * existing component, so a symlink cannot be used to step out of the working directory.
 * @param {string} root
 * @param {string} relative
 * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
 * @returns {Promise<{ abs: string, rel: string }>}
 * @ai.hint io
 */
export async function resolveInside(root, relative, { forWrite = false, allowRoot = true } = {}) {
    if (typeof relative !== 'string') throw new Error('The path must be a string.');
    if (relative.includes('\0')) throw new Error('The path contains a NUL.');
    const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
    const abs = path.resolve(root, cleaned);
    if (!isInside(root, abs)) throw new Error(`The path is outside the working directory: ${relative}`);
    const rel = toPosix(path.relative(root, abs));
    if (rel === '' && !allowRoot) throw new Error('A file path is needed, not the root itself.');
    const segments = rel ? rel.split('/') : [];
    for (const [index, segment] of segments.entries()) {
        if (FORBIDDEN_DIRS.test(segment)) throw new Error(`Access is forbidden: ${rel}`);
        if (index === segments.length - 1 && PROTECTED_FILES.test(segment)) throw new Error(`The file with secrets is not available: ${rel}`);
        if (forWrite && READ_ONLY_DIRS.test(segment)) throw new Error(`Writing into ${segment} is forbidden: ${rel}`);
    }

    let probe = abs;
    for (;;) {
        const info = await lstat(probe).catch(() => null);
        if (info) {
            const real = await realpath(probe).catch(() => probe);
            const realRoot = await realpath(root).catch(() => root);
            if (!isInside(realRoot, real)) throw new Error(`The path leaves the working directory through a symlink: ${rel}`);
            break;
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    return { abs, rel: rel || '.' };
}
