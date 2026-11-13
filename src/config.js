/**
 * @file src/config.js
 * @module config
 * @purpose Load ~/.ai-decompose/config.json, apply defaults, env AI_DECOMPOSE_*, {{env:NAME}} substitutions.
 * @depends node:os, node:path, node:fs/promises
 * @exports defaults, resolveRole, loadConfig, defaultHome
 * @ai.tags config
 * @ai.hint keep
 */
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

/** @returns {string} */
export function defaultHome(env = process.env) {
    const home = env.HOME ?? os.homedir();
    return path.join(home, '.ai-decompose');
}

/**
 * Default configuration. Overridable via ~/.ai-decompose/config.json, env, and CLI flags.
 */
export const defaults = Object.freeze({
    model: 'moonshotai/kimi-k3.1-pro',
    imageModel: 'openai/gpt-image-2.6-sunburst',
    baseURL: 'https://routerai.ru/api/v1',
    apiKey: '{{env:ROUTERAI_API_KEY}}',
    backends: [],
    imagesBackends: [],
    tools: { images: true, fs: true, shell: false },
    image: {
        rasterEngine: 'auto',
        format: 'png',
        background: 'auto',
    },
    limits: { maxTurns: 60 },
    agent: {
        decompose: 'auto',
        decomposerSubReferences: 'auto',
        decomposerMaxTurns: 32,
        decomposerMode: 'standard',
    },
});

/**
 * Replace {{env:NAME}} placeholders in a value.
 * @param {unknown} value
 * @param {Record<string,string>} [env]
 * @returns {unknown}
 */
export function substituteEnv(value, env = process.env) {
    if (typeof value === 'string') {
        return value.replace(/\{\{env:(\w+)\}\}/g, (_, name) => env[name] ?? '');
    }
    if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = substituteEnv(v, env);
        }
        return out;
    }
    return value;
}

/**
 * Resolve a role entry from config, returning the role definition.
 * @param {object} config
 * @param {string} name
 * @returns {object}
 */
export function resolveRole(config, name = 'default') {
    const role = config?.roles?.[name] ?? config?.roles?.default ?? {};
    return {
        model: role.model ?? config?.model ?? defaults.model,
        effort: role.effort ?? null,
        maxTurns: role.turns ?? config?.limits?.maxTurns ?? 60,
        tools: role.tools ?? null,
        imageModel: role.imageModel ?? config?.imageModel ?? null,
    };
}

/**
 * Load configuration: defaults → config file → env overrides → CLI overrides.
 * @param {{ configPath: string|null, overrides: Record<string,unknown>, env: Record<string,string>|null, cwd: string }} opts
 * @returns {Promise<object>}
 */
export async function loadConfig({ configPath = null, overrides = {}, env = null, cwd = process.cwd() } = {}) {
    const cfg = { ...defaults };
    const envObj = env ?? process.env;
    const home = defaultHome(envObj);
    const cfgFile = configPath ? path.resolve(configPath) : path.join(home, 'config.json');

    // Load config file.
    if (configPath || (await stat(cfgFile).catch(() => null))) {
        try {
            const raw = await readFile(cfgFile, 'utf-8');
            // Accept relaxed JSON (comments, trailing commas).
            const parsed = JSON.parse(raw);
            Object.assign(cfg, parsed);
        } catch { /* ignore malformed config */ }
    }

    // Apply env overrides (AI_DECOMPOSE_ prefix).
    for (const [key, val] of Object.entries(envObj)) {
        if (key.startsWith('AI_DECOMPOSE_')) {
            const snake = key.slice('AI_DECOMPOSE_'.length).toLowerCase();
            // Simple one-level override.
            cfg[snake] = val;
        }
    }

    // Apply {{env:NAME}} substitutions.
    Object.assign(cfg, substituteEnv(cfg, envObj));

    // Apply CLI overrides.
    Object.assign(cfg, overrides);

    return Object.freeze(cfg);
}