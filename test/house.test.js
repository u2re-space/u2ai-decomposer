/**
 * @file test/house.test.js
 * @purpose Tests of the law of the house: where the state of a run lives, how the decomposer
 *          signs the contract of the project and how another system finds its work.
 *
 * The house of a project is `.ai/`: the state of a run in `.ai/tmp/<run-id>/`, the assets in
 * `.ai/assets/`, the logs in `.ai/logs/`, the contract in `.ai/manifest.json`. The delivery
 * stays where it is — `decomposition/` — and the paths of the contract count from the root of
 * the project.
 *
 * @depends node:test, shared/house, shared/scratch, stages/publish
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import {
    HOUSE_ASSETS,
    HOUSE_DIR,
    HOUSE_SYSTEMS,
    HOUSE_WORK,
    assetsDir,
    findGenerated,
    houseDir,
    logsDir,
    manifestPath,
    publish,
    readManifest,
    runStateDir,
    toProjectPath,
    workDir,
    workRel,
    writeFileAtomic,
    writeManifest,
} from '../src/shared/house.js';
import { scratchDir } from '../src/shared/scratch.js';
import { publishDelivery } from '../src/stages/publish.js';
import { runPipeline } from '../src/shared/pipeline.js';

/**
 * An empty project in a temporary directory.
 * @returns {Promise<{ root: string, cleanup: () => Promise<void> }>}
 */
async function project() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-house-'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// --- the law of the house ----------------------------------------------------

test('the state of a run lives in the house of the project', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(HOUSE_DIR, '.ai');
        assert.equal(HOUSE_WORK, '.ai/tmp');
        assert.equal(workRel({}), '.ai/tmp');
        assert.equal(workRel({ output: { work: './.ai/tmp' } }), '.ai/tmp');
        assert.equal(workRel({ output: { work: './build' } }), 'build');
        assert.equal(workDir(root), path.join(root, '.ai', 'tmp'));
        assert.equal(runStateDir(root, 'run-1'), path.join(root, '.ai', 'tmp', 'run-1'));
    } finally {
        await cleanup();
    }
});

test('the config may move the state of a run out of the house', async () => {
    const { root, cleanup } = await project();
    try {
        const config = { output: { work: './build/runs' } };
        assert.equal(workRel(config), 'build/runs');
        assert.equal(runStateDir(root, 'run-1', config), path.join(root, 'build', 'runs', 'run-1'));
    } finally {
        await cleanup();
    }
});

test('the assets and the logs of the house lie in their own directories', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(assetsDir(root), path.join(root, '.ai', 'assets'));
        assert.equal(logsDir(root), path.join(root, '.ai', 'logs'));
        assert.equal(HOUSE_ASSETS, 'assets');
        assert.equal(manifestPath(root), path.join(root, '.ai', 'manifest.json'));
        assert.equal(houseDir(root), path.join(root, '.ai'));
    } finally {
        await cleanup();
    }
});

test('the path of a file of the project is relative, a foreign one is absolute', async () => {
    const { root, cleanup } = await project();
    try {
        assert.equal(toProjectPath(root, path.join(root, '.ai', 'manifest.json')), '.ai/manifest.json');
        assert.equal(toProjectPath(root, path.join(root, 'decomposition', 'manifest.json')), 'decomposition/manifest.json');
        assert.equal(toProjectPath(root, path.resolve(root, '..', 'outside.json')), path.resolve(root, '..', 'outside.json'));
    } finally {
        await cleanup();
    }
});

// --- the scratch of a run ----------------------------------------------------

test('the scratch of a run is the state of the run, not a part of the delivery', async () => {
    const { root, cleanup } = await project();
    try {
        const state = { root, runId: 'run-1', config: {} };
        assert.equal(scratchDir(state), path.join(root, '.ai', 'tmp', 'run-1'));
        // The state that comes with the run wins.
        const given = { root, runId: 'run-1', scratchDir: path.join(root, 'elsewhere') };
        assert.equal(scratchDir(given), path.join(root, 'elsewhere'));
    } finally {
        await cleanup();
    }
});

// --- the contract of the project ---------------------------------------------

test('the contract of the project is written and read', async () => {
    const { root, cleanup } = await project();
    try {
        await writeManifest(root, { systems: { webdev: { delivery: '.' } } });
        const manifest = await readManifest(root);
        assert.equal(manifest.manifestVersion, 1);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.ok(manifest.updatedAt);
    } finally {
        await cleanup();
    }
});

test('a broken contract is read as an empty one, not as an error', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, '.ai'), { recursive: true });
        await writeFile(manifestPath(root), '{ this is not json', 'utf8');
        const manifest = await readManifest(root);
        assert.deepEqual(manifest.systems, {});
        assert.equal(manifest.manifestVersion, 1);
    } finally {
        await cleanup();
    }
});

test('a system signs only its own part of the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await publish(root, HOUSE_SYSTEMS.webdev, { delivery: '.', artifacts: { site: '.' } });
        await publish(root, HOUSE_SYSTEMS.decomposer, { delivery: 'decomposition/', artifacts: { screens: 'decomposition/screens/' } });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.webdev.delivery, '.');
        assert.equal(manifest.systems.decomposer.delivery, 'decomposition/');
        assert.equal(manifest.systems.decomposer.artifacts.screens, 'decomposition/screens/');
    } finally {
        await cleanup();
    }
});

test('the work of another system is found through the contract', async () => {
    const { root, cleanup } = await project();
    try {
        await mkdir(path.join(root, 'decomposition'), { recursive: true });
        await writeFile(path.join(root, 'decomposition', 'decomposition.json'), '{}\n', 'utf8');
        await publish(root, HOUSE_SYSTEMS.decomposer, { artifacts: { decomposition: 'decomposition/decomposition.json' } });
        const found = await findGenerated(root, 'decomposition', ['nowhere/sheet.json']);
        assert.equal(found, 'decomposition/decomposition.json');
    } finally {
        await cleanup();
    }
});

// --- the atomic write --------------------------------------------------------

test('a file appears whole: no temporary file is left', async () => {
    const { root, cleanup } = await project();
    try {
        const file = path.join(root, '.ai', 'tmp', 'run-1', 'decompose.json');
        await writeFileAtomic(file, '{"a":1}\n');
        assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
        const left = await readdir(path.dirname(file));
        assert.deepEqual(left, ['decompose.json']);
    } finally {
        await cleanup();
    }
});

test('a failed write leaves no temporary file', async () => {
    const { root, cleanup } = await project();
    try {
        const target = path.join(root, 'locked');
        await mkdir(target, { recursive: true });
        await assert.rejects(async () => writeFileAtomic(target, 'new\n'));
        const left = await readdir(root);
        assert.ok(!left.some((name) => name.includes('.tmp-')), 'the temporary file is left');
    } finally {
        await cleanup();
    }
});

// --- the delivery of the decomposer ------------------------------------------

test('the decomposer signs the contract of the project', async () => {
    const { root, cleanup } = await project();
    try {
        const delivery = path.join(root, 'decomposition');
        await mkdir(path.join(delivery, 'screens'), { recursive: true });
        await mkdir(path.join(delivery, 'rectified'), { recursive: true });
        await writeFile(path.join(root, 'decomposition.json'), '{}\n', 'utf8');
        await writeFile(path.join(delivery, 'manifest.json'), '{}\n', 'utf8');

        await publishDelivery(root, { output: { dir: './decomposition' } }, {
            outDir: '.',
            workDir: 'decomposition',
            runId: 'run-1',
            screens: [{ name: 'home' }],
        });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.decomposer.delivery, 'decomposition/');
        assert.equal(manifest.systems.decomposer.artifacts.decomposition, 'decomposition.json');
        assert.equal(manifest.systems.decomposer.artifacts.manifest, 'decomposition/manifest.json');
        assert.equal(manifest.systems.decomposer.artifacts.screens, 'decomposition/screens/');
        assert.equal(manifest.systems.decomposer.artifacts.rectified, 'decomposition/rectified/');
        assert.equal(manifest.systems.decomposer.runId, 'run-1');
        assert.equal(manifest.systems.decomposer.screens, 1);
    } finally {
        await cleanup();
    }
});

test('a delivery without files signs nothing extra', async () => {
    const { root, cleanup } = await project();
    try {
        await publishDelivery(root, { output: { dir: './decomposition' } }, {
            outDir: '.',
            workDir: 'decomposition',
        });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.decomposer.delivery, 'decomposition/');
        assert.deepEqual(manifest.systems.decomposer.artifacts, {});
    } finally {
        await cleanup();
    }
});

test('the scratch of a run does not lie in the delivery', async () => {
    const { root, cleanup } = await project();
    try {
        const scratch = path.join(root, '.ai', 'tmp', 'run-1');
        await mkdir(scratch, { recursive: true });
        const state = { root, runId: 'run-1', config: {} };
        assert.equal(scratchDir(state), scratch);
        assert.ok(!scratch.startsWith(path.join(root, 'decomposition')), 'the scratch is in the delivery');
    } finally {
        await cleanup();
    }
});

test('the pipeline signs the contract of the project at the end of the run', async () => {
    const { root, cleanup } = await project();
    try {
        const config = { output: { dir: './decomposition', work: './.ai/tmp' }, stages: {} };
        for (const id of ['extend', 'decompose', 'rectify', 'reconstruct', 'overlap', 'resolve']) {
            config.stages[id] = { enabled: false };
        }
        await runPipeline({
            root,
            images: [],
            outDir: '.',
            stages: [],
            config,
            client: {},
            notify: () => {},
        });
        const manifest = await readManifest(root);
        assert.equal(manifest.systems.decomposer.delivery, 'decomposition/');
        // The state of the run lies in the house, and it has the id of the run.
        const states = await readdir(path.join(root, '.ai', 'tmp'));
        assert.equal(states.length, 1);
    } finally {
        await cleanup();
    }
});
