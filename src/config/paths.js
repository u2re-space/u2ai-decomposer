/**
 * Home directory and config file locations.
 *
 * The CLI keeps its state in ~/.ai-decompose (override with
 * AI_DECOMPOSE_HOME); the home config is config.json there.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Agent home directory: AI_DECOMPOSE_HOME, or ~/.ai-decompose.
 * @param {object} [env]
 * @returns {string}
 */
export function defaultHome(env = process.env) {
  return env.AI_DECOMPOSE_HOME ? path.resolve(env.AI_DECOMPOSE_HOME) : path.join(os.homedir(), '.ai-decompose');
}

/**
 * Absolute path of the home config file.
 * @param {string} home
 * @returns {string}
 */
export function homeConfigFile(home) {
  return path.join(home, 'config.json');
}

/**
 * Resolve a --config argument to an absolute path.
 * @param {string|null|undefined} configPath
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveConfigPath(configPath, cwd = process.cwd()) {
  if (!configPath || typeof configPath !== 'string' || !configPath.trim()) return null;
  return path.resolve(cwd, configPath.trim());
}

/**
 * Create the home directory when missing (best effort: a read-only home
 * must not break a run that works entirely from flags).
 * @param {string} home
 * @returns {Promise<void>}
 */
export async function ensureHomeDir(home) {
  try {
    await mkdir(home, { recursive: true });
  } catch { /* ignore */ }
}