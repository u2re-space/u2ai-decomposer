/**
 * Configuration loader of the decomposer CLI.
 *
 * Precedence: defaults < ~/.ai-decompose/config.json < --config file <
 * AI_DECOMPOSE_* environment < CLI overrides. After the merge, placeholders
 * are expanded, the first usable backend is promoted to primary, the config
 * is validated, and the home paths are attached.
 */

import { fromEnv, envConfigPath } from './env.js';
import { isRecord, deepMerge } from './merge.js';
import { ENUMS, KiB } from './constants.js';
import { defaults, cloneDefaults, defaultConfigText } from './defaults.js';
import { readConfigFile, writeConfigFile, expandPlaceholders, mergeSources } from './parser.js';
import { defaultHome, homeConfigFile, resolveConfigPath, ensureHomeDir } from './paths.js';
import { validateConfig } from './validate.js';

export { ENUMS, defaults, cloneDefaults, defaultConfigText, validateConfig, defaultHome, homeConfigFile, resolveConfigPath, ensureHomeDir };

/**
 * Pick the primary backend: the first entry with a URL that also has a key
 * (inline, named env, or none when the whole list is keyless).
 * @param {object[]} backends
 * @param {object} env
 * @returns {{ primary: object|null, apiKey: string|null }}
 */
function pickPrimary(backends, env) {
  const keyOf = (item) => {
    if (typeof item?.apiKey === 'string' && item.apiKey.trim()) return item.apiKey.trim();
    if (typeof item?.env === 'string' && item.env) {
      const value = env[item.env];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const withURL = backends.filter((item) => isRecord(item) && typeof item.baseURL === 'string' && item.baseURL.trim());
  const primary = withURL.find((item) => keyOf(item)) ?? withURL[0] ?? null;
  return { primary, apiKey: primary ? keyOf(primary) : null };
}

/**
 * Resolve the effective configuration.
 * @param {{ configPath?: string|null, overrides?: object, env?: object, cwd?: string, ensureHome?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function loadConfig({ configPath = null, overrides = {}, env = process.env, cwd = process.cwd(), ensureHome = true } = {}) {
  const home = defaultHome(env);
  const homeConfig = await readConfigFile(homeConfigFile(home), { optional: true });
  const explicitPath = resolveConfigPath(configPath ?? envConfigPath(env), cwd);
  const fileConfig = explicitPath ? await readConfigFile(explicitPath) : {};

  let config = mergeSources(homeConfig, fileConfig, fromEnv(env), overrides);
  config = await expandPlaceholders(config, {
    env,
    root: cwd,
    maxBytes: Number.isSafeInteger(config.limits?.maxFileReadBytes) ? config.limits.maxFileReadBytes : 256 * KiB,
  });

  const { primary, apiKey } = pickPrimary(Array.isArray(config.backends) ? config.backends : [], env);
  if (primary) {
    config.baseURL = primary.baseURL;
    if (apiKey) config.apiKey = apiKey;
  }

  config.home = home;
  config.configFiles = [homeConfigFile(home), ...(explicitPath ? [explicitPath] : [])];

  validateConfig(config);
  if (ensureHome) await ensureHomeDir(home);
  return config;
}

/**
 * Seed the home config file when it does not exist yet.
 * @param {object} [env]
 * @returns {Promise<{ created: boolean, file: string }>}
 */
export async function ensureConfigFile(env = process.env) {
  const home = defaultHome(env);
  const file = homeConfigFile(home);
  try {
    await readConfigFile(file, { optional: false });
    return { created: false, file };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeConfigFile(file, JSON.parse(defaultConfigText()));
  return { created: true, file };
}

/**
 * A copy of the config with secrets shortened, safe to print.
 * @param {object} config
 * @returns {object}
 */
export function redactConfig(config) {
  const short = (value) => (typeof value === 'string' && value.length > 6 ? `${value.slice(0, 3)}…${value.slice(-2)}` : value ? '…' : null);
  const out = structuredClone(config);
  if (out.apiKey) out.apiKey = short(out.apiKey);
  for (const branch of ['backends', 'imagesBackends']) {
    if (Array.isArray(out[branch])) {
      for (const item of out[branch]) if (item && typeof item === 'object' && item.apiKey) item.apiKey = short(item.apiKey);
    }
  }
  return out;
}