/**
 * @file test/resume.test.js
 * @module test/resume
 * @purpose Tests of the resume: a run that starts in the middle of the pipeline takes the
 *          screens of the last run from the work directory.
 * @depends node:test, node:fs/promises, shared/resume
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { resumeFromWorkDir } from '../src/shared/resume.js';
import { screenNameOf } from '../src/shared/names.js';
import { readManifest, saveStageManifest } from '../src/shared/manifest.js';

/** A 1×1 PNG: the file only has to exist, the content is never read here. */
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

/**
 * A work directory with the given pictures in the given directories.
 * @param {string} root project root
 * @param {Record<string, string[]>} dirs the pictures of every directory
 * @returns {Promise<void>}
 */
async function workDirWith(root, dirs) {
    for (const [name, files] of Object.entries(dirs)) {
        const dir = path.join(root, 'decomposition', name);
        await mkdir(dir, { recursive: true });
        for (const file of files) await writeFile(path.join(dir, file), PNG_1PX);
    }
}

const stateIn = (root) => ({
    root,
    workDir: path.join(root, 'decomposition'),
    references: ['app.png'],
    images: ['app.png'],
    screens: [],
    screensFiles: [],
});

test('the name of a screen is read from the name of its file', () => {
    assert.equal(screenNameOf('decomposition/screens/01-home.png'), 'home');
    assert.equal(screenNameOf('decomposition/rectified/center-screen.png'), 'center-screen');
    assert.equal(screenNameOf('decomposition/screens/02.png'), '02');
});

test('a run of the restorer takes the screens of the last run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        await workDirWith(root, {
            screens: ['01-app.png'],
            rectified: ['left-screen.png', 'center-screen.png', 'right-screen.png'],
        });
        const state = stateIn(root);
        const events = [];
        const result = await resumeFromWorkDir(state, { stages: ['reconstruct'], notify: (e) => events.push(e) });

        assert.equal(result.resumed, true);
        assert.equal(result.files, 3);
        assert.deepEqual(state.screensFiles.map((file) => file.rel), [
            'decomposition/rectified/center-screen.png',
            'decomposition/rectified/left-screen.png',
            'decomposition/rectified/right-screen.png',
        ]);
        assert.deepEqual(state.screens.map((screen) => screen.name), [
            'center-screen', 'left-screen', 'right-screen',
        ]);
        assert.deepEqual(state.images, state.screensFiles.map((file) => file.rel));
        assert.equal(events.filter((event) => event.type === 'resume').length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a run that cuts the screens is never resumed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        await workDirWith(root, { screens: ['01-app.png'], rectified: ['left-screen.png'] });
        const state = stateIn(root);
        const result = await resumeFromWorkDir(state, { stages: ['decompose', 'reconstruct'] });

        assert.equal(result.resumed, false);
        assert.deepEqual(state.screensFiles, []);
        assert.deepEqual(state.images, ['app.png']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the rectifier takes the screens the decompose stage cut', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        await workDirWith(root, { screens: ['01-app.png', '02-about.png'], rectified: ['left-screen.png'] });
        const state = stateIn(root);
        const result = await resumeFromWorkDir(state, { stages: ['rectify'] });

        assert.equal(result.files, 2);
        assert.deepEqual(state.screensFiles.map((file) => file.rel), [
            'decomposition/screens/01-app.png',
            'decomposition/screens/02-about.png',
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the overlap takes the restored screens when there are any', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        await workDirWith(root, {
            rectified: ['left-screen.png'],
            restored: ['01-left-screen.png'],
            overlap: ['01-left-screen.png'],
        });
        const state = stateIn(root);
        const result = await resumeFromWorkDir(state, { stages: ['overlap'] });

        assert.equal(result.files, 1);
        assert.equal(state.screensFiles[0].rel, 'decomposition/restored/01-left-screen.png');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the names of the last run are kept', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        await workDirWith(root, { rectified: ['01-left.png'] });
        await writeFile(path.join(root, 'decomposition', 'manifest.json'), JSON.stringify({
            stages: {
                rectify: {
                    files: [{
                        rel: 'decomposition/rectified/01-left.png',
                        screen: 'left-dark-onboarding-screen',
                        kind: 'crop',
                        source: 'app.png',
                    }],
                },
            },
        }));
        const state = stateIn(root);
        await resumeFromWorkDir(state, { stages: ['reconstruct'] });

        assert.equal(state.screensFiles[0].screen, 'left-dark-onboarding-screen');
        assert.equal(state.screens[0].name, 'left-dark-onboarding-screen');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the manifest keeps what every stage produced', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        const state = stateIn(root);
        state.screensFiles = [{
            rel: 'decomposition/screens/01-app.png',
            abs: path.join(root, 'decomposition', 'screens', '01-app.png'),
            screen: 'app',
            kind: 'crop',
            source: 'app.png',
        }];
        state.screens = [{ name: 'app', source: 'app.png', subReference: 'decomposition/screens/01-app.png', subReferenceKind: 'crop' }];
        await saveStageManifest(state, 'decompose');

        const manifest = await readManifest(state.workDir);
        assert.deepEqual(manifest.stages.decompose.files.map((file) => file.rel), ['decomposition/screens/01-app.png']);
        assert.equal(manifest.screens[0].name, 'app');
        assert.deepEqual(manifest.chain, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a run without artifacts keeps the pictures it was given', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-resume-'));
    try {
        const state = stateIn(root);
        const result = await resumeFromWorkDir(state, { stages: ['reconstruct'] });

        assert.equal(result.resumed, false);
        assert.deepEqual(state.images, ['app.png']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
