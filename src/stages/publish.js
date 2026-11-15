/**
 * @file src/stages/publish.js
 * @module stages/publish
 * @purpose Sign the contract of the project for the delivery of the decomposer.
 *
 *   The contract of the project is `.ai/manifest.json`: one file that says what every system
 *   of the house made and where it lies. The decomposer signs its own part of it — the final
 *   sheet of the decomposition, the screens it cut and the directories of every stage — and
 *   never touches the part of another system.
 *
 *   The paths in the contract are relative to the project and with forward slashes: the
 *   systems of the house read the contract on another machine and another system, and the
 *   path has to mean the same thing there.
 *
 * @depends node:path, node:fs/promises, agent/decomposition, shared/house, shared/manifest,
 *   stages/extension, stages/rectify, stages/rectify-ai, stages/reconstruct, stages/overlap,
 *   stages/resolve
 * @usedBy shared/pipeline
 * @exports publishDelivery
 * @ai.tags house, manifest, delivery
 * @ai.hint io
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { SCREENS_DIR } from '../agent/decomposition.js';
import { MANIFEST_FILE } from '../shared/manifest.js';
import { HOUSE_SYSTEMS, publish, toProjectPath } from '../shared/house.js';
import { EXTENDED_DIR } from './extension.js';
import { RECTIFIED_DIR } from './rectify.js';
import { REPAIRED_DIR, STRAIGHTENED_DIR } from './rectify-ai.js';
import { RESTORED_DIR } from './reconstruct.js';
import { OVERLAP_DIR } from './overlap.js';
import { DECOMPOSITION_FILE, LAYERS_DIR } from './resolve.js';

/**
 * Whether a file of the delivery is there.
 * @param {string} file
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function there(file) {
    return await stat(file).then((info) => info.isFile()).catch(() => false);
}

/**
 * Whether a directory of the delivery is there.
 * @param {string} dir
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function thereDir(dir) {
    return await stat(dir).then((info) => info.isDirectory()).catch(() => false);
}

/**
 * Publish what the decomposer made.
 *
 * The contract is a hint, not a reason to fail: a run that cannot write it warns and goes on.
 * @param {string} root the project directory
 * @param {object} [config] the config of the run
 * @param {object} [state] the state of the run
 * @returns {Promise<object|null>} the contract after the change, or null
 * @exports
 * @ai.hint io
 */
export async function publishDelivery(root, config = {}, state = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    // The delivery of the decomposer: the directory of the stages, `decomposition/` by default.
    const delivery = toProjectPath(base, path.resolve(base, state.workDir ?? path.join(config?.output?.dir ?? '.', 'decomposition')));
    const artifacts = {};

    /**
     * Name one file of the delivery, if it is there.
     * @param {string} name the name of the artifact
     * @param {string} rel the path of the file, relative to the project
     */
    const add = async (name, rel) => {
        if (await there(path.resolve(base, rel))) artifacts[name] = rel;
    };

    /**
     * Name one directory of the delivery, if it is there.
     * @param {string} name the name of the artifact
     * @param {string} rel the path of the directory, relative to the project
     */
    const addDir = async (name, rel) => {
        if (await thereDir(path.resolve(base, rel))) artifacts[name] = `${rel}/`;
    };

    // The sheet of the decomposition lies next to the delivery: it is the answer of the run.
    const sheet = toProjectPath(base, path.resolve(base, state.outDir ?? '.', DECOMPOSITION_FILE));
    await add('decomposition', sheet);
    await add('manifest', `${delivery}/${MANIFEST_FILE}`);

    // The directories of the stages: what every stage made is here.
    await addDir('screens', `${delivery}/${SCREENS_DIR}`);
    await addDir('extended', `${delivery}/${EXTENDED_DIR}`);
    await addDir('rectified', `${delivery}/${RECTIFIED_DIR}`);
    await addDir('restored', `${delivery}/${RESTORED_DIR}`);
    await addDir('overlap', `${delivery}/${OVERLAP_DIR}`);
    await addDir('repaired', `${delivery}/${REPAIRED_DIR}`);
    await addDir('straightened', `${delivery}/${STRAIGHTENED_DIR}`);

    // The layers of the advanced mode lie next to the sheet as well.
    await addDir('layers', toProjectPath(base, path.resolve(base, state.outDir ?? '.', LAYERS_DIR)));

    return await publish(base, HOUSE_SYSTEMS.decomposer, {
        delivery: `${delivery}/`,
        artifacts,
        extra: {
            runId: state.runId ?? null,
            screens: Array.isArray(state.screens) ? state.screens.length : 0,
        },
    });
}
