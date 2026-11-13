/**
 * @file src/model/profiles.js
 * @purpose Model profiles: context window, max output, effort ceiling.
 * @exports getModelProfile, MODEL_PROFILES
 * @ai.hint keep
 */

/**
 * @typedef {{ window: number, maxOutput: number, ceiling: string, efforts: string[] }} ModelProfile
 */

/** Built-in model profiles. */
export const MODEL_PROFILES = Object.freeze({
    'moonshotai/kimi-k3.1-pro': { window: 8_388_608, maxOutput: 65536, ceiling: 'xhigh', efforts: ['low','medium','high','xhigh'] },
    'openai/gpt-6.1-sol': { window: 4_194_304, maxOutput: 32768, ceiling: 'xhigh', efforts: ['low','medium','high','xhigh'] },
    'openai/gpt-6.1-terra': { window: 2_097_152, maxOutput: 16384, ceiling: 'high', efforts: ['low','medium','high'] },
    'openai/gpt-6-luna': { window: 1_048_576, maxOutput: 8192, ceiling: 'medium', efforts: ['low','medium'] },
    'openai/gpt-image-2.6-sunburst': { window: 0, maxOutput: 0, ceiling: 'none', efforts: [] },
});

/**
 * Get the profile for a model, falling back to a generic default.
 * @param {string} model
 * @returns {ModelProfile}
 */
export function getModelProfile(model) {
    return MODEL_PROFILES[model] ?? { window: 1_048_576, maxOutput: 8192, ceiling: 'medium', efforts: ['low','medium','high'] };
}