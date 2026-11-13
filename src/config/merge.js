/**
 * @file src/config/merge.js
 * @module config/merge
 * @purpose Deep merge of configuration sources and the record test every normalizer needs.
 * @exports isRecord, deepMerge, getPath, setPath
 * @ai.tags config, merge
 * @ai.hint pure
 */

/**
 * True for a plain object: not null, not an array.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge `extra` over `base`. Records merge field by field, arrays and primitives replace,
 * so a config file lists one backend and does not have to repeat the defaults of the others.
 * Neither argument is mutated.
 * @param {object} base
 * @param {object|null|undefined} extra
 * @returns {object}
 */
export function deepMerge(base, extra) {
    if (!isRecord(extra)) return isRecord(base) ? { ...base } : base;
    if (!isRecord(base)) return structuredClone(extra);
    const out = { ...base };
    for (const [key, value] of Object.entries(extra)) {
        out[key] = isRecord(value) && isRecord(base[key]) ? deepMerge(base[key], value) : structuredClone(value);
    }
    return out;
}

/**
 * Read `a.b.c` from a config tree.
 * @param {object} source
 * @param {string[]} path
 * @returns {unknown}
 */
export function getPath(source, path) {
    let owner = source;
    for (const step of path) {
        if (!isRecord(owner)) return undefined;
        owner = owner[step];
    }
    return owner;
}

/**
 * Write `a.b.c` into a config tree, creating the records on the way.
 * @param {object} target
 * @param {string[]} path
 * @param {unknown} value
 * @returns {boolean} true when the leaf existed and was replaced
 */
export function setPath(target, path, value) {
    const last = path.at(-1);
    let owner = target;
    for (const step of path.slice(0, -1)) {
        if (!isRecord(owner[step])) owner[step] = {};
        owner = owner[step];
    }
    if (!isRecord(owner)) return false;
    const had = Object.hasOwn(owner, last);
    owner[last] = value;
    return had;
}
