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
  model: 'minimax/minimax-m3.1-flash',//'moonshotai/kimi-k3.1-pro',
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
  /**
   * The window of silence the text host may keep before the request is given up.
   * It is not a budget of the call: a streamed answer keeps sending events while the
   * model thinks, so the window only fires when the host really stops talking.
   */
  timeoutMs: 600_000,
  /**
   * The same window for the image route. A picture comes in one piece — there is no
   * stream to keep the connection awake — so the window is longer.
   */
  imageTimeoutMs: 900_000,
  /** Ask the roles for a streamed answer, so a slow call shows its progress. */
  streaming: true,

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
  /**
   * Ordered hosts of the layer route — the host that splits a screen into layers.
   *
   * The layer split is a different model on a different host: only APIMart serves seedream-5.5,
   * and the picture hosts above do not know it. The key is read from the environment variable
   * named in `env`, so it never lands in the config file.
   */
  layerBackends: [
    { baseURL: 'https://api.apimart.ai/v1', env: 'APIMART_API_KEY' },
  ],
  /** Per-model host lists: { "<model>": [{ baseURL, apiKey?, prefix?, vendor?, suffix?, type? }] }. */
  modelsBackends: {},
  /**
   * The models to try when the picture model refuses the request — no balance, no route.
   * Key: the model that failed, value: the list of models that get the request next.
   * The hosts of `imagesBackends` are tried first; a model of this list is the next step.
   */
  fallback: {
    enabled: true,
    models: {
      'openai/gpt-image-2.6-sunburst': ['bytedance-seed/seedream-5-5'],
      "moonshotai/kimi-k3.1-pro": ["minimax/minimax-m3.1-flash"],
      "minimax/minimax-m3.1-flash": []
    },
  },

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
       * even when enabled). 0.125 adds an eighth-frame band around the art —
       * enough for a status bar or a row of buttons, not a whole extra screen.
       */
      padFraction: 0.125,
      /** Max verify-and-stitch attempts on the extended band. */
      maxAttempts: 2,
      /**
       * The quality of the picture the editor is asked for. The band is a background
       * that is stitched at the edge of the source, so the cheapest quality is enough
       * — and a `high` band costs many times more than the whole rest of the run.
       */
      quality: 'low',
    },
    decompose: {
      enabled: true,
      mode: ENUMS.decomposerModes[0],
      /** Max agent turns for the decomposer role. */
      maxTurns: 32,
      /** Sub-references the stage may keep per decomposition. */
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
      /** Max attempts per screen (the first projection plus the retries); a re-cut counts as one. */
      maxAttempts: 3,
      /** Residual tilt (deg) that counts as a level screen. */
      residualSkewLimitDeg: 0.8,
      /** How much flatter the result has to be than the source. */
      minImprovementDeg: 0.4,
      /** Let the role look at its own cut and cut it again when a screen lost its edges. */
      review: true,
    },
    reconstruct: {
      enabled: true,
      /** Max AI repair attempts per lost detail. */
      maxAttempts: 2,
      /**
       * How many times the AI may work on one screen. A pass is the whole visit: the plan of the
       * role and the repair of the regions it named. Three by default.
       */
      maxPasses: 3,
      /** Padding (px) around a lost-detail box before patching. */
      boxPadding: 16,
      /** Max regions of one screen that may be repaired in one pass. */
      maxPatches: 3,
      /**
       * The quality of the answer the editor gives for one fragment. A fragment is a
       * strip of background that is stitched back into one box, so the cheapest quality
       * is enough: a `high` answer costs many times more and buys nothing there.
       */
      quality: 'low',
      /** The geometry the role names and the harness applies to the pixels. */
      geometry: {
        /** Apply the rotation and the size correction the role asks for. */
        enabled: true,
        /** The largest tilt the harness will apply, in degrees. */
        maxRotateDeg: 6,
        /** The largest size correction the harness will apply, in percent. */
        maxScalePercent: 10,
        /** How much flatter the screen has to be for the correction to be kept, in degrees. */
        minImprovementDeg: 0.2,
      },
    },
    overlap: {
      enabled: true,
      /** Max AI erase attempts per overlapping element. */
      maxAttempts: 2,
      /** Padding (px) around an overlap box before patching. */
      boxPadding: 16,
      /** Max regions of one screen that may be cleaned in one pass. */
      maxPatches: 3,
      /** The quality of the answer the editor gives for one fragment. */
      quality: 'low',
    },
    resolve: {
      enabled: true,
      /** Emit layers/ next to decomposition.json (advanced decomposition). */
      layers: false,
      /** Max layers of one screen kept from the split. */
      maxLayers: 32,
      /** Where the layers come from: auto | seedream | director. */
      layerSource: 'auto',
      /** The model of the layer route: the one that splits a screen into layers. */
      layerModel: 'seedream-5-5',
      /** The tier the seedream decomposition runs at: auto | 1K | 1.5K | 2K. */
      layerSize: 'auto',
      /** Ask the image model for the OCR of the text layers. */
      textRecognition: true,
      /** The prompt of the seedream decomposition (the tight-box wording by default). */
      layerPrompt: null,
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

  // --- MCP ------------------------------------------------------------------
  /**
   * External tool servers. Each entry is either `{ name, url }` for an HTTP
   * server or `{ name, command, args }` for a server started over stdio.
   */
  mcp: { servers: [] },

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
    layerBackends: structuredClone(defaults.layerBackends),
    fallback: structuredClone(defaults.fallback),
    stages: { extend: { padFraction: 0.125 }, resolve: { layers: false } },
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}