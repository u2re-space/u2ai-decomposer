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
  reconstruct     Restore lost details via AI box-patch and verify.
  overlap         Remove overlapping elements from/by other screens (AI).
  resolve         Assemble final decomposition.json + layers (advanced).

Every stage reports what it decided and what it produced; the run ends with a summary
of the output path, the screens and the number of layers.

Config:
  Stored in ~/.ai-decompose/config.json.
  Environment variables prefixed with AI_DECOMPOSE_.
  Supports {{env:NAME}} substitutions.

Examples:
  ai-decompose -i screenshot.png
  ai-decompose -i collage.png --stages decompose,rectify
  ai-decompose -i original.png --advanced --out ./output
`;