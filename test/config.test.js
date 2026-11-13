/**
 * @file test/config.test.js
 * @purpose Smoke tests of the configuration: the precedence of the sources, the placeholders,
 *          the refusal of a broken file, and the redaction of the secrets.
 * @depends node:test, config
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
    defaults,
    ensureConfigFile,
    loadConfig,
    redactConfig,
    validateConfig,
} from '../src/config.js';

/** A home directory of its own, so the real one is never touched. */
const homeDir = async () => await mkdtemp(path.join(os.tmpdir(), 'ai-decompose-home-'));

/** Write a config file into the home directory. */
const writeHomeConfig = async (home, data) => {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'config.json'), JSON.stringify(data, null, 2));
};

const cleanEnv = (home, extra = {}) => ({ AI_DECOMPOSE_HOME: home, ...extra });

test('the defaults are a valid configuration', () => {
    assert.doesNotThrow(() => validateConfig(structuredClone(defaults)));
});

test('the config file overrides the defaults', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { model: 'file/model', reasoning: { effort: 'high' } });
        const config = await loadConfig({ env: cleanEnv(home), ensureHome: false });
        assert.equal(config.model, 'file/model');
        assert.equal(config.reasoning.effort, 'high');
        assert.equal(config.imageModel, defaults.imageModel, 'the rest of the defaults stay');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the environment overrides the file, and the flags override the environment', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { model: 'file/model' });
        const fromEnv = await loadConfig({
            env: cleanEnv(home, { AI_DECOMPOSE_MODEL: 'env/model' }),
            ensureHome: false,
        });
        assert.equal(fromEnv.model, 'env/model');

        const fromFlags = await loadConfig({
            env: cleanEnv(home, { AI_DECOMPOSE_MODEL: 'env/model' }),
            overrides: { model: 'cli/model' },
            ensureHome: false,
        });
        assert.equal(fromFlags.model, 'cli/model');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a placeholder is expanded after the sources are merged', async () => {
    const home = await homeDir();
    try {
        await writeHomeConfig(home, { apiKey: '{{env:MY_OWN_KEY}}' });
        const config = await loadConfig({
            env: cleanEnv(home, { MY_OWN_KEY: 'the-secret' }),
            ensureHome: false,
        });
        assert.equal(config.apiKey, 'the-secret');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a file placeholder is read from the disk', async () => {
    const home = await homeDir();
    try {
        await writeFile(path.join(home, 'key.txt'), 'from-a-file');
        await writeHomeConfig(home, { apiKey: '{{file:./key.txt}}' });
        const config = await loadConfig({ env: cleanEnv(home), cwd: home, ensureHome: false });
        assert.equal(config.apiKey, 'from-a-file');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('a broken config file is refused with a message that names it', async () => {
    const home = await homeDir();
    try {
        await mkdir(home, { recursive: true });
        await writeFile(path.join(home, 'config.json'), '{ this is not json');
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /некорректный JSON/,
        );

        await writeHomeConfig(home, { whatever: true });
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /неизвестный раздел/,
        );

        await writeHomeConfig(home, { reasoning: { effort: 'turbo' } });
        await assert.rejects(
            () => loadConfig({ env: cleanEnv(home), ensureHome: false }),
            /reasoning\.effort/,
        );
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('the secret is shortened before the config is printed', () => {
    const printed = redactConfig({ ...defaults, apiKey: 'sk-very-secret-key' });
    assert.notEqual(printed.apiKey, 'sk-very-secret-key');
    assert.ok(!String(printed.apiKey).includes('secret'));
    assert.equal(printed.model, defaults.model, 'the rest of the config is printed as it is');
});

test('the home config is seeded when it does not exist yet', async () => {
    const home = await homeDir();
    try {
        const first = await ensureConfigFile(cleanEnv(home));
        assert.equal(first.created, true);
        const written = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
        assert.equal(written.model, defaults.model);
        // The starter is a partial config: it is valid on top of the defaults.
        const config = await loadConfig({ env: cleanEnv(home), ensureHome: false });
        assert.equal(config.model, defaults.model);
        assert.equal(config.imageModel, defaults.imageModel);
        const second = await ensureConfigFile(cleanEnv(home));
        assert.equal(second.created, false, 'an existing file is not overwritten');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
