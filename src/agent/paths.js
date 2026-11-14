/**
 * @file src/agent/paths.js
 * @module agent/paths
 * @purpose Keep model paths inside the working directory and refuse secrets and symlink escapes.
 * @depends access/paths
 * @usedBy agent/tools, agent/decomposition
 * @exports toPosix, isInside, resolveInside
 * @ai.tags paths, sandbox
 * @ai.hint keep
 * @changed 2026-11-14 The rules moved to the access layer; the words stay the same.
 */
import { toPosix, isInside, resolveInside as resolveInsideBase } from '../access/paths.js';

export { toPosix, isInside };

/**
 * The words of the refusals: the package keeps its own, the rules are shared.
 * @type {Readonly<{ outside: Function, secret: Function, denied: Function, readOnly: Function, symlink: Function }>}
 */
const MESSAGES = Object.freeze({
    outside: (relative) => `The path is outside the working directory: ${relative}`,
    secret: (rel) => `The file with secrets is not available: ${rel}`,
    denied: (rel) => `Access is forbidden: ${rel}`,
    readOnly: (segment, rel) => `Writing into ${segment} is forbidden: ${rel}`,
    symlink: (rel) => `The path leaves the working directory through a symlink: ${rel}`,
});

/**
 * Resolve a model-supplied path to an absolute path inside `root`.
 * Refuses the escapes (through `..` and through symlinks), the secrets and the writes
 * into the read-only directories.
 * @param {string} root
 * @param {string} relative
 * @param {{ forWrite?: boolean, allowRoot?: boolean }} [options]
 * @returns {Promise<{ abs: string, rel: string }>}
 * @exports
 * @ai.hint io
 */
export async function resolveInside(root, relative, { forWrite = false, allowRoot = true } = {}) {
    return resolveInsideBase(root, relative, { forWrite, allowRoot, messages: MESSAGES });
}
