/**
 * Configuration fields taken from the environment.
 *
 * Precedence inside the CLI: defaults < config.json < --config file < env <
 * CLI overrides. This module only maps env names to config paths; merging is
 * the loader's job. `AI_DECOMPOSE_*` is the primary namespace; the plain
 * `OPENAI_*` / `AI_*` names are accepted for compatibility with the
 * monolith's user setup.
 */

import { ENUMS } from './constants.js';

/**
 * Parse one env value as a bounded integer.
 * @param {string|undefined} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function intInRange(raw, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Parse one env value as a JSON array of backend entries; invalid input is ignored.
 * @param {string|undefined} raw
 * @returns {object[]|null}
 */
function backendList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build a partial config object from environment variables.
 * @param {object} [env]
 * @returns {object}
 */
export function fromEnv(env = process.env) {
  const out = {};
  const set = (path, value) => {
    if (value === undefined || value === null || value === '') return;
    let owner = out;
    for (const step of path.slice(0, -1)) {
      owner[step] ??= {};
      owner = owner[step];
    }
    owner[path.at(-1)] = value;
  };

  // --- API -----------------------------------------------------------------
  set(['model'], env.AI_DECOMPOSE_MODEL ?? env.AI_MODEL ?? env.OPENAI_MODEL);
  set(['imageModel'], env.AI_DECOMPOSE_IMAGE_MODEL ?? env.AI_IMAGE_MODEL);
  set(['baseURL'], env.AI_DECOMPOSE_BASE_URL ?? env.OPENAI_BASE_URL);
  set(['apiKey'], env.AI_DECOMPOSE_API_KEY ?? env.OPENAI_API_KEY);
  set(['organization'], env.OPENAI_ORG_ID);
  set(['project'], env.OPENAI_PROJECT_ID);

  // --- reasoning ------------------------------------------------------------
  if (ENUMS.reasoningEfforts.includes(env.AI_DECOMPOSE_EFFORT)) set(['reasoning', 'effort'], env.AI_DECOMPOSE_EFFORT);

  // --- HTTP plumbing --------------------------------------------------------
  const retries = intInRange(env.AI_DECOMPOSE_RETRIES, 0, 10);
  if (retries != null) set(['retries'], retries);
  const timeoutMs = intInRange(env.AI_DECOMPOSE_TIMEOUT_MS, 5_000, 600_000);
  if (timeoutMs != null) set(['timeoutMs'], timeoutMs);
  const imageTimeoutMs = intInRange(env.AI_DECOMPOSE_IMAGE_TIMEOUT_MS, 5_000, 1_800_000);
  if (imageTimeoutMs != null) set(['imageTimeoutMs'], imageTimeoutMs);
  if (env.AI_DECOMPOSE_STREAMING === '0' || env.AI_DECOMPOSE_STREAMING === 'false') set(['streaming'], false);
  else if (env.AI_DECOMPOSE_STREAMING === '1' || env.AI_DECOMPOSE_STREAMING === 'true') set(['streaming'], true);
  const maxTurns = intInRange(env.AI_DECOMPOSE_MAX_TURNS, 1, 200);
  if (maxTurns != null) set(['limits', 'maxTurns'], maxTurns);

  // --- backends -------------------------------------------------------------
  const backends = backendList(env.AI_DECOMPOSE_BACKENDS);
  if (backends) set(['backends'], backends);
  const imagesBackends = backendList(env.AI_DECOMPOSE_IMAGES_BACKENDS);
  if (imagesBackends) set(['imagesBackends'], imagesBackends);

  // --- raster ---------------------------------------------------------------
  if (ENUMS.rasterEngines.includes(env.AI_DECOMPOSE_RASTER_ENGINE)) set(['raster', 'engine'], env.AI_DECOMPOSE_RASTER_ENGINE);
  set(['raster', 'magickPath'], env.AI_DECOMPOSE_MAGICK_PATH);

  // --- stages ---------------------------------------------------------------
  for (const stage of ENUMS.stages) {
    const flag = env[`AI_DECOMPOSE_STAGE_${stage.toUpperCase()}`];
    if (flag === '0' || flag === 'false') set(['stages', stage, 'enabled'], false);
    else if (flag === '1' || flag === 'true') set(['stages', stage, 'enabled'], true);
  }
  const pad = Number(env.AI_DECOMPOSE_PAD_FRACTION);
  if (Number.isFinite(pad) && pad >= 0 && pad <= 1) set(['stages', 'extend', 'padFraction'], pad);

  return out;
}

/**
 * The config file named by the environment, if any.
 * @param {object} [env]
 * @returns {string|null}
 */
export function envConfigPath(env = process.env) {
  return env.AI_DECOMPOSE_CONFIG || null;
}