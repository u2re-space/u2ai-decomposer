/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */
export * from './openai/client.js';
export * from './openai/errors.js';
export * from './openai/responses.js';
export * from './openai/images.js';
export * from './openai/fallback.js';
export * from './openai/chat.js';
export * from './config.js';
export * from './image/raster.js';
export * from './image/magick.js';
export * from './image/skew.js';
export * from './image/distort.js';
export * from './image/rectify.js';
export * from './image/crop.js';
export * from './image/padding.js';
export * from './image/sizing.js';
export * from './model/profiles.js';
export * from './roles/index.js';
export * from './agent/tools.js';
export * from './agent/tool-specs.js';
export * from './agent/mcp.js';
export * from './agent/skills.js';
export * from './agent/schemas.js';
export * from './agent/decomposition.js';
export * from './agent/paths.js';
export * from './shared/pipeline.js';
export * from './stages/extension.js';
export * from './stages/decompose.js';
export * from './stages/decompose-screens.js';
export * from './stages/rectify.js';
export * from './stages/reconstruct.js';
export * from './stages/overlap.js';
export * from './stages/resolve.js';
