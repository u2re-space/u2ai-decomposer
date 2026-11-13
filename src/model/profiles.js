/**
 * @file src/model/profiles.js
 * @module model/profiles
 * @purpose Model profiles: context window, max output, effort ceiling and effort ladder.
 * @exports MODEL_PROFILES, getModelProfile, snapEffort, contextBytes, maxOutputFor
 * @ai.tags model, profiles
 * @ai.hint pure
 */
import { ENUMS } from '../config/constants.js';

/**
 * @typedef {{ window: number, maxOutput: number, ceiling: string|null, efforts: string[]|null }} ModelProfile
 */

/** Built-in model profiles. A ceiling of `null` means "no built-in limit". */
export const MODEL_PROFILES = Object.freeze({
    'moonshotai/kimi-k3.1-pro': { window: 8_388_608, maxOutput: 65_536, ceiling: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh'] },
    'openai/gpt-6.1-sol': { window: 4_194_304, maxOutput: 32_768, ceiling: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh'] },
    'openai/gpt-6.1-terra': { window: 2_097_152, maxOutput: 16_384, ceiling: 'high', efforts: ['low', 'medium', 'high'] },
    'openai/gpt-6-luna': { window: 1_048_576, maxOutput: 8_192, ceiling: 'medium', efforts: ['low', 'medium'] },
    'openai/gpt-image-2.6-sunburst': { window: 0, maxOutput: 0, ceiling: null, efforts: [] },
});

/** The profile of a model that is not in the table. */
const DEFAULT_PROFILE = Object.freeze({
    window: 131_072,
    maxOutput: 16_384,
    ceiling: 'medium',
    efforts: ['low', 'medium', 'high'],
});

/**
 * The profile of a model, with the `models` section of the config applied on top.
 * @param {string|null} model
 * @param {object} [config]
 * @returns {ModelProfile}
 * @exports
 */
export function getModelProfile(model, config = null) {
    const base = MODEL_PROFILES[model] ?? DEFAULT_PROFILE;
    const override = config?.models?.[model];
    if (!override || typeof override !== 'object') return base;
    const merged = {
        window: Number.isSafeInteger(override.window) ? override.window : base.window,
        maxOutput: Number.isSafeInteger(override.maxOutput) ? override.maxOutput : base.maxOutput,
        ceiling: override.ceiling === null ? null : (override.ceiling ?? base.ceiling),
        efforts: Array.isArray(override.efforts) ? override.efforts : base.efforts,
    };
    return merged;
}

/**
 * The order of the effort levels, from the cheapest to the most expensive.
 * @type {string[]}
 */
const EFFORT_ORDER = Object.freeze([...ENUMS.reasoningEfforts]);

/**
 * Clamp an effort to what the model accepts.
 *
 * The ceiling is a hard limit. The ladder is a set of levels the model really understands:
 * a level above the ladder is pulled down to the closest level below it.
 * @param {string|null} effort
 * @param {ModelProfile} profile
 * @returns {string|null}
 * @exports
 */
export function snapEffort(effort, profile) {
    if (!effort) return null;
    const wanted = String(effort);
    if (!EFFORT_ORDER.includes(wanted)) return null;

    let ceiling = profile?.ceiling ?? null;
    if (ceiling && EFFORT_ORDER.includes(ceiling)) {
        const ceilingIndex = EFFORT_ORDER.indexOf(ceiling);
        const wantedIndex = EFFORT_ORDER.indexOf(wanted);
        if (wantedIndex > ceilingIndex) return ceiling;
    }

    const ladder = Array.isArray(profile?.efforts) ? profile.efforts.filter((item) => EFFORT_ORDER.includes(item)) : null;
    if (!ladder || !ladder.length) return wanted;
    if (ladder.includes(wanted)) return wanted;

    const wantedIndex = EFFORT_ORDER.indexOf(wanted);
    let best = null;
    for (const item of ladder) {
        const index = EFFORT_ORDER.indexOf(item);
        if (index <= wantedIndex && (best === null || index > EFFORT_ORDER.indexOf(best))) best = item;
    }
    return best ?? ladder[0];
}

/**
 * The context budget in bytes.
 *
 * A word (`small`, `normal`, `large`, `max`) is a fixed budget; `auto` is the window of the
 * model; a number is a byte count.
 * @param {string|number|null} level
 * @param {ModelProfile} profile
 * @returns {number}
 * @exports
 */
export function contextBytes(level, profile) {
    if (Number.isSafeInteger(level) && level > 0) return level;
    const word = String(level ?? 'auto').trim().toLowerCase();
    if (word === 'auto') return Math.max(0, profile?.window ?? DEFAULT_PROFILE.window);
    const known = ENUMS.contextLevels[word];
    if (known) return known;
    const parsed = Number.parseInt(word, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    return Math.max(0, profile?.window ?? DEFAULT_PROFILE.window);
}

/**
 * The output cap of a model for a request.
 * @param {string|null} model
 * @param {object} [config]
 * @param {number|null} [requested]
 * @returns {number|null}
 * @exports
 */
export function maxOutputFor(model, config = null, requested = null) {
    const profile = getModelProfile(model, config);
    if (Number.isSafeInteger(requested) && requested > 0) {
        return profile.maxOutput > 0 ? Math.min(requested, profile.maxOutput) : requested;
    }
    return profile.maxOutput > 0 ? profile.maxOutput : null;
}
