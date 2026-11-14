/**
 * Allowed values and shared literals of the configuration system.
 *
 * These enums are the contract between the parser, the validator and the
 * stages: a config value outside them is a user error and fails the load.
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** Env prefix of this CLI (the monolith uses AI_*, ours is namespaced). */
export const ENV_PREFIX = 'AI_DECOMPOSE_';

export const ENUMS = Object.freeze({
  reasoningEfforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  reasoningSummaries: Object.freeze(['auto', 'concise', 'detailed']),
  reasoningModes: Object.freeze(['off', 'priority']),
  /** Word context levels; resolved to bytes by the model profile at load time. */
  contextLevels: Object.freeze({ small: 16 * KiB, normal: 96 * KiB, large: 512 * KiB, max: 8 * MiB }),
  contextWords: Object.freeze(['auto', 'small', 'normal', 'large', 'max']),
  /** Backend entries may declare which API routes the host serves. */
  backendRoutes: Object.freeze(['responses', 'chat', 'images', 'batch']),
  imageFormats: Object.freeze(['png', 'jpeg', 'webp']),
  imageQualities: Object.freeze(['low', 'medium', 'high', 'auto']),
  imageSizes: Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto']),
  imageBackgrounds: Object.freeze(['auto', 'transparent', 'opaque']),
  /** Pipeline stages in execution order. */
  stages: Object.freeze(['extend', 'decompose', 'rectify', 'reconstruct', 'overlap', 'resolve']),
  decomposerModes: Object.freeze(['agent', 'inline']),
  /** Where the layers of the advanced mode come from. */
  layerSources: Object.freeze(['auto', 'seedream', 'director']),
  /** The tiers the seedream decomposition accepts; ratios and pixel frames are refused. */
  seedreamLayerSizes: Object.freeze(['auto', '1K', '1.5K', '2K']),
  rasterEngines: Object.freeze(['auto', 'sharp', 'canvas', 'magick']),
});

/** Role names that always exist; user roles are validated against the schema only. */
export const BUILTIN_ROLE_NAMES = Object.freeze([
  'default', 'extender', 'decomposer', 'rectifier', 'restorer', 'overlap', 'director',
]);

/** Alias spellings accepted in backend `supports` maps. */
export const SUPPORT_ALIASES = Object.freeze({
  responseapi: 'responses', responses: 'responses',
  chatapi: 'chat', chat: 'chat', chatcompletions: 'chat', completions: 'chat',
  imageapi: 'images', images: 'images',
  batchapi: 'batch', batches: 'batch',
});

/** RFC 7230 token characters for header names in backend entries. */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;