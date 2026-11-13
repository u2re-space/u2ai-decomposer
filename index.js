/**
 * @file index.js
 * @purpose Public programmatic API: client, config, image-layer, roles, stages.
 * @ai.hint keep
 */
export { createClient, ApiError } from './src/openai/client.js';
export { loadConfig, defaults as configDefaults } from './src/config.js';
export { rasterInfo, rasterCrop, rasterPatch, decodeRgba, rasterPadImageBytes } from './src/image/raster.js';
export { createRoleRunner } from './src/roles/index.js';
export { runPipeline, STAGES } from './src/shared/pipeline.js';
export { EXTEND_SCHEMA, RECTIFY_SCHEMA, RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA, DECOMPOSER_SCHEMA, SUB_REFERENCE_KINDS } from './src/agent/schemas.js';