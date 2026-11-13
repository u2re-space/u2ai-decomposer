/**
 * Default configuration of the decomposer CLI.
 *
 * Shape mirrors the monolith's config minus the agent-transport fields this
 * CLI does not have (approve, desktop, browser, mcp, telegram, memory, jobs).
 * Every section listed here is also the allow-list for user config files.
 */

import { ENUMS } from './constants.js';

export const defaults = {
  // --- API -----------------------------------------------------------------
  /** Text model for the role agents. */
  model: 'moonshotai/kimi-k3.1-pro',
  /** Picture model for generate/edit tools and the reconstruct stage. */
  imageModel: 'openai/gpt-image-2.6-sunburst',
  /** Endpoint of both APIs; backends[] below can override it per route. */
  baseURL: 'https://routerai.ru/api/v1',
  apiKey: null,
  organization: null,
  project: null,
  /** Send `store: true` on API calls. */
  store: false,
  truncation: 'auto',
  verbosity: null,
  temperature: null,
  maxOutputTokens: null,
  /** Per-model ceilings: { "<model>": { window, maxOutput, ceiling } }. */
  models: {},
  reasoning: { effort: 'medium', summary: 'auto', mode: null },
  retries: 3,
  timeoutMs: 120_000,

  // --- HTTP backends -------------------------------------------------------
  /**
   * Ordered text-API hosts; the first usable one becomes the primary.
   * Entry: { baseURL, apiKey?, env?, headers?, body?, supports? }.
   * `env` is the environment variable name for the key (checked when apiKey
   * is not set).
   */
  backends: [
    { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
    { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY' },
    { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
    { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
  ],
  /** Ordered picture-API hosts (same entry shape). */
  imagesBackends: [
    { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY' },
    { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
    { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
    { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
  ],
  /** Per-model host lists: { "<model>": [{ baseURL, apiKey?, prefix?, vendor?, suffix?, type? }] }. */
  modelsBackends: {},
  fallback: { enabled: true, models: {} },

  // --- limits ---------------------------------------------------------------
  limits: {
    /** Wall-clock budget per stage. */
    stageTimeoutMs: 15 * 60_000,
    /** Agent-loop turns per role call. */
    maxTurns: 24,
    /** Retries per API request. */
    requestRetries: 3,
    /** Max raster bytes an image tool may return into the context. */
    maxImageBytes: 8 * 1024 * 1024,
    /** Cap for {{file:...}} substitutions in config strings. */
    maxFileReadBytes: 256 * 1024,
  },

  // --- tools ----------------------------------------------------------------
  tools: {
    read: true,
    write: true,
    image_view: true,
    image_crop: true,
    image_split: true,
    image_compare: true,
    image_correct_perspective: true,
    image_generate: true,
    image_edit: true,
  },

  // --- raster ----------------------------------------------------------------
  raster: {
    /** sharp -> canvas -> ImageMagick fallback chain. */
    engine: 'auto',
    /** ImageMagick binary when the engine is magick/auto. */
    magickPath: null,
  },

  // --- image pipeline knobs ---------------------------------------------------
  image: {
    format: 'png',
    quality: 'high',
    background: 'auto',
    /** Downscale cap for images sent to the model, longest edge px. */
    maxSide: 1536,
    /** JPEG quality (0..100) for model-bound copies when format is jpeg. */
    jpegQuality: 90,
    /** Max decoded megapixels before a raster op refuses (canvas bomb cap). */
    maxMegapixels: 100,
    /** Alpha threshold 0..1: pixels below it count as erased. */
    alphaThreshold: 0.05,
    /** Rectify stage: residual-skew (deg) above which a re-correct loop runs. */
    residualSkewLimitDeg: 1.5,
    /** Rectify stage: seam delta (0..1) below which a quad is accepted. */
    seamDeltaMin: 0.25,
    /** Rectify stage: seam band width, fraction of canvas height. */
    seamBandFraction: 0.06,
  },

  // --- stages -----------------------------------------------------------------
  stages: {
    extend: {
      enabled: true,
      /**
       * Fraction of the long edge to grow the canvas by (0 disables the stage
       * even when enabled). 0.25 adds a quarter-frame band around the art.
       */
      padFraction: 0.25,
      /** Max verify-and-stitch attempts on the extended band. */
      maxAttempts: 2,
    },
    decompose: {
      enabled: true,
      mode: ENUMS.decomposerModes[0],
      /** Sub-references the agent stage may hand out per call. */
      maxSubReferences: 12,
      /** Inline-mode caps: rects and pixels per request. */
      maxRects: 24,
      maxInlinePixels: 64 * 1_000_000,
      /** Drop cropped screens below this side length (px). */
      minScreenSide: 48,
    },
    rectify: {
      enabled: true,
      /** Max agent turns for the un-rotate/recover-projection pass. */
      maxTurns: 24,
      /** Max agent turns for the per-screen split pass. */
      maxSplitTurns: 32,
    },
    reconstruct: {
      enabled: true,
      /** Max AI repair attempts per lost detail. */
      maxAttempts: 2,
      /** Padding (px) around a lost-detail box before patching. */
      boxPadding: 16,
    },
    overlap: {
      enabled: true,
      /** Max AI erase attempts per overlapping element. */
      maxAttempts: 2,
    },
    resolve: {
      enabled: true,
      /** Emit layers/ next to decomposition.json (advanced decomposition). */
      layers: false,
    },
  },

  /** Where pipeline artifacts are written, relative to cwd. */
  output: { dir: './decomposition', file: './decomposition.json' },

  // --- roles ----------------------------------------------------------------
  /**
   * Per-role overrides. Model/effort resolution chain:
   * role -> roles.default -> top level. `instructions` are appended to the
   * role prompt; `imageModel`/`vectorModel` travel with the role.
   */
  roles: {
    default: { model: null, effort: null, summary: null, maxEffort: null, context: null, temperature: null, maxOutputTokens: null, instructions: null, tools: null, imageModel: null, vectorModel: null },
    extender: {},
    decomposer: {},
    rectifier: {},
    restorer: {},
    overlap: {},
    director: {},
  },

  /** Extra named roles merged into the role registry at load. */
  customRoles: {},

  /** Output root for role skills (read-only skill packs per role). */
  skills: { dir: null },
};

/** Allowed fields of one `roles.<name>` entry (null = inherited). */
export const ROLE_FIELDS = Object.freeze([
  'model', 'effort', 'summary', 'maxEffort', 'context', 'temperature',
  'maxOutputTokens', 'instructions', 'tools', 'imageModel', 'vectorModel',
]);

export function cloneDefaults() {
  return structuredClone(defaults);
}

/**
 * Starter file written to ~/.ai-decompose/config.json on first run: only the
 * fields a user is expected to edit; everything else stays on the defaults.
 */
export function defaultConfigText() {
  const starter = {
    model: defaults.model,
    imageModel: defaults.imageModel,
    reasoning: { effort: 'xhigh', summary: 'auto' },
    backends: structuredClone(defaults.backends),
    imagesBackends: structuredClone(defaults.imagesBackends),
    stages: { extend: { padFraction: 0.25 }, resolve: { layers: false } },
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}