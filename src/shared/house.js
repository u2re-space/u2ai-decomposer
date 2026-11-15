/**
 * @file src/shared/house.js
 * @module shared/house
 * @purpose The law of the generation: where a run puts what it makes, and how the systems of
 *          the house find each other's work.
 *
 *   The house has one directory in a project: `.ai/`. Everything a run produces that is not
 *   the product itself lives there, and nowhere else:
 *
 *   - `.ai/tmp/<run-id>/` — the state of the run: the plan, the context, the map, the
 *     scratch. It dies with the run, and a new run never reads the state of the old one.
 *   - `.ai/assets/` — the assets the house makes: the pictures, the decorations.
 *   - `.ai/logs/` — the log of the API calls.
 *   - `.ai/manifest.json` — the contract of the project: what every system made and where it
 *     lies. One file, one format, one writer. A system never guesses where another one put
 *     its work: it reads the contract, and only then the old paths.
 *
 *   The product stays where the user expects it: the site in the root of the project, the
 *   delivery of the measurer in `measurements/`, the delivery of the decomposer in
 *   `decomposition/`. The house only keeps the state, the assets and the contract.
 *
 *   The rules live here and only here, and the file is the same in every package of the
 *   house: when it changes, it changes everywhere.
 *
 * @depends node:path, node:fs/promises
 * @usedBy stages, agent, commands, cli
 * @exports HOUSE_DIR, HOUSE_TMP, HOUSE_ASSETS, HOUSE_LOGS, HOUSE_WORK, MANIFEST_FILE,
 *          MANIFEST_VERSION, HOUSE_SYSTEMS, houseDir, workRel, workDir, runStateDir, assetsDir,
 *          logsDir, manifestPath, toProjectPath, readManifest, writeManifest, publish,
 *          findGenerated, writeFileAtomic
 * @ai.tags house, layout, manifest
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

/** The directory of the house in a project. */
export const HOUSE_DIR = '.ai';

/** The name of the directory of the state of a run, inside the house. */
export const HOUSE_TMP = 'tmp';

/** The name of the directory of the assets of the house, inside the house. */
export const HOUSE_ASSETS = 'assets';

/** The name of the directory of the logs of the house, inside the house. */
export const HOUSE_LOGS = 'logs';

/** The path of the state of the runs, relative to the project. */
export const HOUSE_WORK = `${HOUSE_DIR}/${HOUSE_TMP}`;

/** The name of the contract of the project. */
export const MANIFEST_FILE = 'manifest.json';

/** The version of the contract: a reader that does not know the version reads nothing. */
export const MANIFEST_VERSION = 1;

/** The systems of the house: the name each of them signs the contract with. */
export const HOUSE_SYSTEMS = Object.freeze({
    webdev: 'webdev',
    measurer: 'measurer',
    decomposer: 'decomposer',
    images: 'images',
    server: 'server',
});

/**
 * The directory of the house in a project.
 * @param {string} [root] the project directory
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function houseDir(root = process.cwd()) {
    return path.resolve(String(root ?? process.cwd()), HOUSE_DIR);
}

/**
 * The path of the state of the runs, as the project sees it: relative, with forward slashes.
 *
 * The config may move the state of the runs away from the house, and then it wins: the law
 * gives the default, the user gives the exception. In every case the path is one, and it is
 * computed here and nowhere else.
 * @param {object} [config] the config of the run
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function workRel(config = {}) {
    const work = String(config?.output?.work ?? HOUSE_WORK).trim();
    if (!work) return HOUSE_WORK;
    return work.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The directory of the state of the runs, absolute.
 * @param {string} [root] the project directory
 * @param {object} [config] the config of the run
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function workDir(root = process.cwd(), config = {}) {
    return path.resolve(String(root ?? process.cwd()), workRel(config));
}

/**
 * The directory of the state of one run: `<root>/.ai/tmp/<run-id>/`.
 * @param {string} [root] the project directory
 * @param {string} [runId] the id of the run
 * @param {object} [config] the config of the run
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function runStateDir(root = process.cwd(), runId = '', config = {}) {
    const base = workDir(root, config);
    const id = String(runId ?? '').trim();
    return id ? path.join(base, id) : base;
}

/**
 * The directory of the assets of the house: `<root>/.ai/assets/`.
 * @param {string} [root] the project directory
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function assetsDir(root = process.cwd()) {
    return path.resolve(String(root ?? process.cwd()), HOUSE_DIR, HOUSE_ASSETS);
}

/**
 * The directory of the logs of the house: `<root>/.ai/logs/`.
 * @param {string} [root] the project directory
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function logsDir(root = process.cwd()) {
    return path.resolve(String(root ?? process.cwd()), HOUSE_DIR, HOUSE_LOGS);
}

/**
 * The path of the contract of the project: `<root>/.ai/manifest.json`.
 * @param {string} [root] the project directory
 * @returns {string} the absolute path
 * @exports
 * @ai.hint pure
 */
export function manifestPath(root = process.cwd()) {
    return path.join(houseDir(root), MANIFEST_FILE);
}

/**
 * The path of a file as the project sees it: relative to the root, with forward slashes.
 *
 * The path of a file outside the root stays absolute: the house never pretends that a file
 * outside the project belongs to it.
 * @param {string} root the project directory
 * @param {string} target the absolute path of the file
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function toProjectPath(root, target) {
    const base = path.resolve(String(root ?? process.cwd()));
    const abs = path.resolve(String(target ?? ''));
    const relative = path.relative(base, abs);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return abs;
    return relative.split(path.sep).join('/');
}

/**
 * Read the contract of the project.
 *
 * A missing contract, a broken contract and a contract of an unknown version all give an
 * empty one: the contract is a hint, not a reason to fail.
 * @param {string} [root] the project directory
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function readManifest(root = process.cwd()) {
    const text = await readFile(manifestPath(root), 'utf8').catch(() => null);
    if (text === null) return { manifestVersion: MANIFEST_VERSION, systems: {} };
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') throw new Error('the contract is not an object');
        if (parsed.manifestVersion !== MANIFEST_VERSION) {
            return { manifestVersion: MANIFEST_VERSION, systems: {} };
        }
        if (!parsed.systems || typeof parsed.systems !== 'object') parsed.systems = {};
        return parsed;
    } catch {
        return { manifestVersion: MANIFEST_VERSION, systems: {} };
    }
}

/**
 * Write the contract of the project.
 *
 * The write is atomic: the file of the contract is replaced whole, so a run that dies in the
 * middle leaves the old contract and not half of a new one.
 * @param {string} [root] the project directory
 * @param {object} manifest the contract
 * @returns {Promise<string>} the path of the contract
 * @exports
 * @ai.hint io
 */
export async function writeManifest(root = process.cwd(), manifest = {}) {
    const file = manifestPath(root);
    const systems = manifest?.systems && typeof manifest.systems === 'object' ? manifest.systems : {};
    const next = {
        ...manifest,
        manifestVersion: MANIFEST_VERSION,
        updatedAt: new Date().toISOString(),
        systems,
    };
    await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return file;
}

/**
 * Sign the contract for one system: what it made and where it lies.
 *
 * The sections of the other systems stay as they are: every system owns its own part of the
 * contract and never touches the part of another one.
 * @param {string} [root] the project directory
 * @param {string} system the name of the system
 * @param {{ delivery?: string, artifacts?: object, extra?: object }} [payload]
 * @returns {Promise<object>} the contract after the change
 * @exports
 * @ai.hint io
 */
export async function publish(root = process.cwd(), system, payload = {}) {
    const name = String(system ?? '').trim();
    if (!name) throw new Error('The name of the system is needed.');
    const manifest = await readManifest(root);
    const section = manifest.systems[name] && typeof manifest.systems[name] === 'object'
        ? manifest.systems[name]
        : {};
    const next = {
        ...section,
        updatedAt: new Date().toISOString(),
        ...(payload?.delivery ? { delivery: String(payload.delivery) } : {}),
        artifacts: payload?.artifacts && typeof payload.artifacts === 'object'
            ? { ...(section.artifacts ?? {}), ...payload.artifacts }
            : (section.artifacts ?? {}),
        ...(payload?.extra && typeof payload.extra === 'object' ? { ...payload.extra } : {}),
    };
    manifest.systems[name] = next;
    await writeManifest(root, manifest);
    return manifest;
}

/**
 * Find what a system made, by the name of the artifact.
 *
 * The contract comes first: the system that made the thing named where it lies. The old
 * paths come after, so a project that was made before the contract still works.
 * @param {string} [root] the project directory
 * @param {string} name the name of the artifact (`measurements`, `palette`, `tokens`, ...)
 * @param {string[]} [candidates] the old paths, relative to the root
 * @returns {Promise<string|null>} the path relative to the root, or null
 * @exports
 * @ai.hint io
 */
export async function findGenerated(root = process.cwd(), name, candidates = []) {
    const base = path.resolve(String(root ?? process.cwd()));
    const there = async (rel) => {
        const text = String(rel ?? '').trim();
        if (!text) return null;
        const abs = path.isAbsolute(text) ? text : path.resolve(base, text);
        const info = await stat(abs).catch(() => null);
        return info ? abs : null;
    };
    const manifest = await readManifest(base);
    for (const section of Object.values(manifest.systems ?? {})) {
        const artifacts = section?.artifacts;
        if (!artifacts || typeof artifacts !== 'object') continue;
        const value = artifacts[name];
        const paths = Array.isArray(value) ? value : (value ? [value] : []);
        for (const rel of paths) {
            const abs = await there(rel);
            if (abs) return toProjectPath(base, abs);
        }
    }
    for (const rel of Array.isArray(candidates) ? candidates : []) {
        const abs = await there(rel);
        if (abs) return toProjectPath(base, abs);
    }
    return null;
}

/**
 * Write a file whole: the file is written next to its place and renamed over it.
 *
 * A run that dies in the middle of a write leaves the old file and not half of a new one.
 * @param {string} file the path of the file
 * @param {string|Buffer} data the content
 * @returns {Promise<string>} the path of the file
 * @exports
 * @ai.hint io
 */
export async function writeFileAtomic(file, data) {
    const target = path.resolve(String(file));
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
        await writeFile(temporary, data);
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
    return target;
}
