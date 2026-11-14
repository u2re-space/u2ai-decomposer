/**
 * @file src/help.js
 * @module help
 * @purpose Help text for ai-decompose.
 * @exports HELP
 * @ai.hint keep
 */

export const HELP = `ai-decompose — multi-phase AI-agentic image decomposer

Usage:
  ai-decompose [options]

Options:
  -i, --image <path>      Input reference image(s). Can be specified multiple times.
  -o, --out <dir>         Output directory (default: .).
  -c, --config <path>     Path to ~/.ai-decompose/config.json.
  --stages <name,...>     Comma-separated list of stages to run.
                          Default: extend,decompose,rectify,reconstruct,overlap,resolve
                          Available: extend, decompose, rectify, reconstruct, overlap, resolve
  -m, --model <name>      AI model override.
  --image-model <name>    Image editing model override.
  --effort <level>        Reasoning effort: low | medium | high | xhigh.
  --advanced              Enable advanced mode (layer split: seedream-5.5 or the director role).
  --dry-run               Show what would be done without executing.
  --stop-after <stage>    Stop after this stage (inclusive).
  -v, --verbose           Verbose output.
  -h, --help              Show this help message.
  --version               Show version.

Pipeline stages:
  extend          Grow reference frame if content is cut through real content.
                  Any edge, several edges at once.
  decompose       Split reference into ordered screens with sub-references.
  rectify         Un-rotate / recover projection, cut collages into screens.
                  The role checks its own cut and cuts it again when a screen
                  lost its edges.
  reconstruct     Restore lost details via AI box-patch and verify.
                  The role names the tilt and the size of the screen, the
                  harness corrects the pixels and rolls the correction back
                  when the measurement says it did not help.
  overlap         Remove overlapping elements from/by other screens (AI).
  resolve         Assemble final decomposition.json + layers (advanced).

Every stage reports what it decided and what it produced; the run ends with a summary
of the output path, the screens and the number of layers.

Config:
  Stored in ~/.ai-decompose/config.json.
  Environment variables prefixed with AI_DECOMPOSE_.
  Supports {{env:NAME}} substitutions.
  The picture hosts of imagesBackends are tried one by one; when all of them
  refuse the model, the next model of fallback.models gets the request.

Examples:
  ai-decompose -i screenshot.png
  ai-decompose -i collage.png --stages decompose,rectify
  ai-decompose -i original.png --advanced --out ./output
`;