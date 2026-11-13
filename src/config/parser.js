/**
 * Config file parsing, placeholder expansion and writing.
 *
 * Files are strict JSON (BOM tolerated) whose top-level keys must exist in
 * the defaults. Strings may embed {{env:NAME}} and {{file:path}}
 * placeholders, expanded after the merge so that a value can come from any
 * source.
 */

import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { defaults } from './defaults.js';
import { isRecord, deepMerge } from './merge.js';
import { KiB } from './constants.js';

const MAX_PLACEHOLDER_DEPTH = 8;
const PLACEHOLDER = /\{\{\s*(env|file|fs)\s*:\s*([^}]+?)\s*\}\}/g;

/**
 * Read and parse one config JSON object. Unknown keys are rejected.
 * A missing file is `{}` when optional, an error otherwise.
 * @param {string} file
 * @param {{ optional?: boolean, maxBytes?: number }} [options]
 * @returns {Promise<object>}
 */
export async function readConfigFile(file, { optional = false, maxBytes = 256 * KiB } = {}) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {};
    const wrapped = new Error(`Не удалось прочитать конфигурацию ${file}: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  }
  if (Buffer.byteLength(raw) > maxBytes) throw new Error(`Конфигурация ${file} больше ${Math.floor(maxBytes / KiB)} KiB.`);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Конфигурация ${file}: некорректный JSON (${error.message}).`);
  }
  if (!isRecord(parsed)) throw new Error(`Конфигурация ${file} должна быть JSON-объектом.`);
  for (const key of Object.keys(parsed)) {
    if (!(key in defaults)) throw new Error(`Конфигурация ${file}: неизвестный раздел "${key}".`);
  }
  return parsed;
}

/**
 * Write a config object as pretty JSON (used to seed the home config).
 * @param {string} file
 * @param {object} data
 * @returns {Promise<void>}
 */
export async function writeConfigFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Expand {{env:NAME}} and {{file:path}} inside every string of the tree.
 * @param {unknown} node
 * @param {{ env?: object, root?: string, maxBytes?: number }} [options]
 * @param {number} [depth]
 * @returns {Promise<unknown>}
 */
export async function expandPlaceholders(node, { env = process.env, root = process.cwd(), maxBytes = 256 * KiB } = {}, depth = 0) {
  if (depth > MAX_PLACEHOLDER_DEPTH) throw new Error('Конфигурация: слишком глубокая подстановка {{...}}.');
  if (typeof node === 'string') {
    if (!node.includes('{{')) return node;
    const parts = [];
    let cursor = 0;
    PLACEHOLDER.lastIndex = 0;
    let match;
    while ((match = PLACEHOLDER.exec(node))) {
      parts.push(node.slice(cursor, match.index));
      const [, kind, rawArg] = match;
      if (kind === 'env') {
        const name = rawArg.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          parts.push(match[0]); // not a variable name: leave the text as it is
        } else {
          // A missing variable expands to an empty string (same as the monolith),
          // so a config listing five gateways never dies on the four unset keys.
          const value = env[name];
          parts.push(value == null ? '' : String(value));
        }
      } else {
        const target = path.isAbsolute(rawArg) ? rawArg : path.resolve(root, rawArg);
        let text;
        try {
          text = await readFile(target, 'utf8');
        } catch (error) {
          throw new Error(`Конфигурация: не удалось прочитать {{file:${rawArg}}}: ${error.message}`);
        }
        if (Buffer.byteLength(text) > maxBytes) throw new Error(`Конфигурация: {{file:${rawArg}}} больше ${Math.floor(maxBytes / KiB)} KiB.`);
        parts.push(text);
      }
      cursor = match.index + match[0].length;
    }
    parts.push(node.slice(cursor));
    return expandPlaceholders(parts.join(''), { env, root, maxBytes }, depth + 1);
  }
  if (Array.isArray(node)) return Promise.all(node.map((item) => expandPlaceholders(item, { env, root, maxBytes }, depth)));
  if (isRecord(node)) {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = await expandPlaceholders(value, { env, root, maxBytes }, depth);
    return out;
  }
  return node;
}

/**
 * Merge a list of partial configs over the defaults (later wins).
 * @param {...object} sources
 * @returns {object}
 */
export function mergeSources(...sources) {
  return sources.reduce((acc, extra) => deepMerge(acc, extra), structuredClone(defaults));
}