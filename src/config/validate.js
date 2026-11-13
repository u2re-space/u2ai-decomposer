/**
 * Validation of the merged configuration against the enums and the
 * allow-lists of defaults. Every failure names the exact config path so the
 * CLI can print one actionable line.
 */

import { ENUMS, HEADER_NAME, SUPPORT_ALIASES, KiB } from './constants.js';
import { defaults, ROLE_FIELDS } from './defaults.js';
import { isRecord } from './merge.js';

/**
 * Validate an optional header map: token names, single-line string values.
 * @param {unknown} headers
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateHeaders(headers, where, fail) {
  if (headers == null) return;
  if (!isRecord(headers)) fail(`${where} должен быть объектом`);
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) fail(`${where}.${name}: некорректное имя заголовка`);
    if (typeof value !== 'string' || /[\r\n]/.test(value)) fail(`${where}.${name}: строка без перевода строки`);
  }
}

/** Normalize + validate a backend `supports` map via the alias table. */
function validateSupports(supports, where, fail) {
  if (supports == null) return;
  if (!isRecord(supports)) fail(`${where} должен быть объектом`);
  for (const [rawKey, value] of Object.entries(supports)) {
    const key = SUPPORT_ALIASES[rawKey.toLowerCase()] ?? rawKey;
    if (!ENUMS.backendRoutes.includes(key)) fail(`${where}.${rawKey}: ${ENUMS.backendRoutes.join(' | ')}`);
    if (typeof value !== 'boolean') fail(`${where}.${rawKey}: true | false`);
  }
}

/**
 * Validate one backend list (backends / imagesBackends).
 * @param {unknown} list
 * @param {string} where
 * @param {(message: string) => never} fail
 */
function validateBackendList(list, where, fail) {
  if (!Array.isArray(list)) fail(`${where} должен быть массивом`);
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) fail(`${where}[${index}] должен быть объектом`);
    const entry = `${where}[${index}]`;
    for (const key of Object.keys(item)) {
      if (!['baseURL', 'apiKey', 'env', 'headers', 'body', 'supports'].includes(key)) fail(`${entry}.${key}: неизвестное поле`);
    }
    if (typeof item.baseURL !== 'string' || !item.baseURL.trim()) fail(`${entry}.baseURL должен быть URL`);
    try { new URL(item.baseURL); } catch { fail(`${entry}.baseURL должен быть URL`); }
    if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${entry}.apiKey: строка или null`);
    if (item.env != null && (typeof item.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.env))) fail(`${entry}.env: имя переменной или null`);
    validateHeaders(item.headers, `${entry}.headers`, fail);
    validateSupports(item.supports, `${entry}.supports`, fail);
  }
}

/**
 * Validate per-model backend lists: { model: [{ baseURL, ... }] }.
 */
function validateModelBackends(map, fail) {
  if (!isRecord(map)) fail('modelsBackends должен быть объектом');
  for (const [model, list] of Object.entries(map)) {
    if (!model.trim()) fail('modelsBackends: ключ модели не должен быть пустым');
    if (!Array.isArray(list) || !list.length) fail(`modelsBackends.${model} должен быть непустым массивом`);
    for (const [index, item] of list.entries()) {
      const entry = `modelsBackends.${model}[${index}]`;
      if (!isRecord(item)) fail(`${entry} должен быть объектом`);
      for (const key of Object.keys(item)) {
        if (!['baseURL', 'apiKey', 'prefix', 'vendor', 'suffix', 'type'].includes(key)) fail(`${entry}.${key}: неизвестное поле`);
      }
      if (typeof item.baseURL !== 'string' || !item.baseURL.trim()) fail(`${entry}.baseURL должен быть URL`);
      try { new URL(item.baseURL); } catch { fail(`${entry}.baseURL должен быть URL`); }
      if (item.apiKey != null && (typeof item.apiKey !== 'string' || /[\r\n]/.test(item.apiKey))) fail(`${entry}.apiKey: строка или null`);
      if (item.type != null && !['auto', 'text', 'images'].includes(item.type)) fail(`${entry}.type: auto | text | images`);
    }
  }
}

/** Validate one stage section against the shape known for that stage. */
function validateStage(id, section, fail) {
  const where = `stages.${id}`;
  if (!isRecord(section)) fail(`${where} должен быть объектом`);
  if (typeof section.enabled !== 'boolean') fail(`${where}.enabled: true | false`);
  const known = defaults.stages[id] ?? {};
  for (const key of Object.keys(section)) {
    if (!(key in known)) fail(`${where}.${key}: неизвестное поле (допустимо: ${Object.keys(known).join(', ')})`);
  }
  if (id === 'extend') {
    if (!(Number.isFinite(section.padFraction) && section.padFraction >= 0 && section.padFraction <= 1)) fail(`${where}.padFraction: число 0..1`);
    if (!(Number.isSafeInteger(section.maxAttempts) && section.maxAttempts >= 0)) fail(`${where}.maxAttempts: целое ≥ 0`);
  }
  if (id === 'decompose') {
    if (!ENUMS.decomposerModes.includes(section.mode)) fail(`${where}.mode: ${ENUMS.decomposerModes.join(' | ')}`);
    for (const key of ['maxTurns', 'maxSubReferences', 'maxRects', 'maxInlinePixels', 'minScreenSide']) {
      if (!(Number.isSafeInteger(section[key]) && section[key] > 0)) fail(`${where}.${key}: целое > 0`);
    }
  }
  if (id === 'rectify' || id === 'reconstruct' || id === 'overlap') {
    for (const key of ['maxTurns', 'maxSplitTurns', 'maxAttempts', 'boxPadding', 'maxPatches']) {
      if (key in section && !(Number.isSafeInteger(section[key]) && section[key] >= 0)) fail(`${where}.${key}: целое ≥ 0`);
    }
  }
  if (id === 'rectify') {
    for (const key of ['residualSkewLimitDeg', 'minImprovementDeg']) {
      if (!(Number.isFinite(section[key]) && section[key] >= 0)) fail(`${where}.${key}: число ≥ 0`);
    }
  }
  if (id === 'resolve') {
    if (typeof section.layers !== 'boolean') fail(`${where}.layers: true | false`);
    if ('maxLayers' in section && !(Number.isSafeInteger(section.maxLayers) && section.maxLayers >= 0)) {
      fail(`${where}.maxLayers: целое ≥ 0`);
    }
  }
}

/**
 * Throw when any merged value is outside the accepted enums and ranges.
 * @param {object} config
 * @returns {void}
 */
export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Конфигурация: ${message}`); };
  const c = config;

  if (typeof c.model !== 'string' || !c.model.trim()) fail('укажите model (или AI_DECOMPOSE_MODEL / --model).');
  if (c.imageModel !== null && (typeof c.imageModel !== 'string' || !c.imageModel.trim())) fail('imageModel должен быть строкой или null.');
  if (typeof c.baseURL !== 'string' || !c.baseURL.trim()) fail('baseURL должен быть URL.');
  try { new URL(c.baseURL); } catch { fail('baseURL должен быть URL.'); }
  if (c.apiKey !== null && (typeof c.apiKey !== 'string' || /[\r\n]/.test(c.apiKey))) fail('apiKey: строка или null.');

  if (!isRecord(c.models)) fail('models должен быть объектом');
  for (const [modelId, profile] of Object.entries(c.models)) {
    if (!isRecord(profile)) fail(`models.${modelId} должен быть объектом`);
    for (const key of Object.keys(profile)) {
      if (!['window', 'maxOutput', 'ceiling'].includes(key)) fail(`models.${modelId}.${key}: неизвестное поле`);
    }
    if (profile.window != null && !(Number.isSafeInteger(profile.window) && profile.window > 0)) fail(`models.${modelId}.window: целое > 0`);
    if (profile.maxOutput != null && !(Number.isSafeInteger(profile.maxOutput) && profile.maxOutput > 0)) fail(`models.${modelId}.maxOutput: целое > 0`);
    if (profile.ceiling != null && !ENUMS.reasoningEfforts.includes(profile.ceiling)) fail(`models.${modelId}.ceiling: ${ENUMS.reasoningEfforts.join(' | ')}`);
  }

  if (!isRecord(c.reasoning)) fail('reasoning должен быть объектом');
  for (const key of Object.keys(c.reasoning)) if (!(key in defaults.reasoning)) fail(`reasoning.${key}: неизвестное поле`);
  if (c.reasoning.effort !== null && !ENUMS.reasoningEfforts.includes(c.reasoning.effort)) fail(`reasoning.effort: ${ENUMS.reasoningEfforts.join(' | ')}`);
  if (c.reasoning.summary !== null && !ENUMS.reasoningSummaries.includes(c.reasoning.summary)) fail(`reasoning.summary: ${ENUMS.reasoningSummaries.join(' | ')}`);
  if (c.reasoning.mode !== null && c.reasoning.mode !== undefined && !ENUMS.reasoningModes.includes(c.reasoning.mode)) fail(`reasoning.mode: ${ENUMS.reasoningModes.join(' | ')}`);
  if (c.verbosity !== null && !['low', 'medium', 'high'].includes(c.verbosity)) fail('verbosity: low | medium | high');
  if (c.temperature !== null && !(Number.isFinite(c.temperature) && c.temperature >= 0 && c.temperature <= 2)) fail('temperature: 0..2');
  if (c.maxOutputTokens !== null && !(Number.isSafeInteger(c.maxOutputTokens) && c.maxOutputTokens >= 16)) fail('maxOutputTokens ≥ 16');
  if (typeof c.store !== 'boolean') fail('store: true | false');
  if (!['auto', 'disabled'].includes(c.truncation)) fail('truncation: auto | disabled');
  if (!Number.isSafeInteger(c.retries) || c.retries < 0 || c.retries > 10) fail('retries: 0..10');
  if (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 5_000 || c.timeoutMs > 600_000) fail('timeoutMs: 5000..600000');

  validateBackendList(c.backends, 'backends', fail);
  validateBackendList(c.imagesBackends, 'imagesBackends', fail);
  validateModelBackends(c.modelsBackends, fail);
  if (!isRecord(c.fallback)) fail('fallback должен быть объектом');
  if (typeof c.fallback.enabled !== 'boolean') fail('fallback.enabled: true | false');

  for (const [key, value] of Object.entries(c.limits)) {
    if (!(key in defaults.limits)) fail(`неизвестный лимит limits.${key}`);
    if (!(Number.isSafeInteger(value) && value > 0)) fail(`limits.${key}: положительное целое`);
  }

  for (const [key, value] of Object.entries(c.tools)) {
    if (!(key in defaults.tools) || typeof value !== 'boolean') fail(`tools.${key}: true | false (известные: ${Object.keys(defaults.tools).join(', ')})`);
  }

  if (!isRecord(c.raster)) fail('raster должен быть объектом');
  for (const key of Object.keys(c.raster)) if (!(key in defaults.raster)) fail(`raster.${key}: неизвестное поле`);
  if (!ENUMS.rasterEngines.includes(c.raster.engine)) fail(`raster.engine: ${ENUMS.rasterEngines.join(' | ')}`);
  if (c.raster.magickPath !== null && (typeof c.raster.magickPath !== 'string' || !c.raster.magickPath.trim())) fail('raster.magickPath: непустая строка или null');

  if (!isRecord(c.image)) fail('image должен быть объектом');
  for (const key of Object.keys(c.image)) if (!(key in defaults.image)) fail(`image.${key}: неизвестное поле`);
  if (!ENUMS.imageFormats.includes(c.image.format)) fail(`image.format: ${ENUMS.imageFormats.join(' | ')}`);
  if (!ENUMS.imageQualities.includes(c.image.quality)) fail(`image.quality: ${ENUMS.imageQualities.join(' | ')}`);
  if (!ENUMS.imageBackgrounds.includes(c.image.background)) fail(`image.background: ${ENUMS.imageBackgrounds.join(' | ')}`);
  if (!(Number.isSafeInteger(c.image.maxSide) && c.image.maxSide >= 128)) fail('image.maxSide: целое ≥ 128');
  if (!(Number.isSafeInteger(c.image.jpegQuality) && c.image.jpegQuality >= 1 && c.image.jpegQuality <= 100)) fail('image.jpegQuality: 1..100');
  if (!(Number.isSafeInteger(c.image.maxMegapixels) && c.image.maxMegapixels > 0)) fail('image.maxMegapixels: целое > 0');
  if (!(Number.isFinite(c.image.alphaThreshold) && c.image.alphaThreshold >= 0 && c.image.alphaThreshold <= 1)) fail('image.alphaThreshold: 0..1');
  if (!(Number.isFinite(c.image.residualSkewLimitDeg) && c.image.residualSkewLimitDeg > 0 && c.image.residualSkewLimitDeg < 15)) fail('image.residualSkewLimitDeg: 0..15');
  if (!(Number.isFinite(c.image.seamDeltaMin) && c.image.seamDeltaMin > 0 && c.image.seamDeltaMin < 1)) fail('image.seamDeltaMin: 0..1');
  if (!(Number.isFinite(c.image.seamBandFraction) && c.image.seamBandFraction > 0 && c.image.seamBandFraction < 0.5)) fail('image.seamBandFraction: 0..0.5');

  if (!isRecord(c.stages)) fail('stages должен быть объектом');
  for (const key of Object.keys(c.stages)) {
    if (!ENUMS.stages.includes(key)) fail(`stages.${key}: неизвестная стадия (${ENUMS.stages.join(' | ')})`);
  }
  for (const id of ENUMS.stages) validateStage(id, c.stages[id], fail);

  if (!isRecord(c.output)) fail('output должен быть объектом');
  for (const key of ['dir', 'file']) {
    if (typeof c.output[key] !== 'string' || !c.output[key].trim()) fail(`output.${key}: непустая строка`);
  }

  if (!isRecord(c.roles)) fail('roles должен быть объектом');
  for (const [name, role] of Object.entries(c.roles)) {
    if (!name.trim()) fail('roles: пустое имя роли');
    if (!isRecord(role)) fail(`roles.${name} должен быть объектом`);
    for (const key of Object.keys(role)) {
      if (!ROLE_FIELDS.includes(key)) fail(`roles.${name}.${key}: неизвестное поле`);
    }
    if (role.model != null && (typeof role.model !== 'string' || !role.model.trim())) fail(`roles.${name}.model: строка или null`);
    if (role.effort !== null && role.effort != null && !ENUMS.reasoningEfforts.includes(role.effort)) fail(`roles.${name}.effort: ${ENUMS.reasoningEfforts.join(' | ')}`);
    if (role.maxEffort != null && !ENUMS.reasoningEfforts.includes(role.maxEffort)) fail(`roles.${name}.maxEffort: ${ENUMS.reasoningEfforts.join(' | ')}`);
    if (role.context != null && !(ENUMS.contextWords.includes(role.context) || (Number.isSafeInteger(role.context) && role.context > 0))) fail(`roles.${name}.context: ${ENUMS.contextWords.join(' | ')} или байты`);
    if (role.tools != null && !Array.isArray(role.tools)) fail(`roles.${name}.tools: массив имён или null`);
    if (role.instructions != null && typeof role.instructions !== 'string') fail(`roles.${name}.instructions: строка или null`);
  }

  if (!isRecord(c.customRoles)) fail('customRoles должен быть объектом');
  if (!isRecord(c.mcp)) fail('mcp должен быть объектом');
  for (const key of Object.keys(c.mcp)) if (!(key in defaults.mcp)) fail(`mcp.${key}: неизвестное поле`);
  if (!Array.isArray(c.mcp.servers)) fail('mcp.servers: массив серверов');
  c.mcp.servers.forEach((server, index) => {
    if (!isRecord(server)) fail(`mcp.servers[${index}]: объект`);
    if (server.name != null && (typeof server.name !== 'string' || !server.name.trim())) fail(`mcp.servers[${index}].name: непустая строка или null`);
    if (server.url != null && (typeof server.url !== 'string' || !server.url.trim())) fail(`mcp.servers[${index}].url: непустая строка или null`);
    if (server.command != null && (typeof server.command !== 'string' || !server.command.trim())) fail(`mcp.servers[${index}].command: непустая строка или null`);
    if (!server.url && !server.command) fail(`mcp.servers[${index}]: нужен url или command`);
    if (server.args != null && !Array.isArray(server.args)) fail(`mcp.servers[${index}].args: массив строк или null`);
  });
  if (c.skills != null) {
    if (!isRecord(c.skills)) fail('skills должен быть объектом');
    if (c.skills.dir !== null && (typeof c.skills.dir !== 'string' || !c.skills.dir.trim())) fail('skills.dir: путь или null');
  }
}