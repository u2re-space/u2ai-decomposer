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
                          A stage may run alone: it takes the screens of the last run
                          from the work directory and the stages before it are not repeated.
  -m, --model <name>      AI model override.
  --image-model <name>    Image editing model override.
  --effort <level>        Reasoning effort: low | medium | high | xhigh.
  --advanced              Enable advanced mode (layer split: seedream-5.5 or the director role).
  --dry-run               Show what would be done without executing.
  --stop-after <stage>    Stop after this stage (inclusive).
  --batch                 Submit the requests of the parallel rounds as one batch
                          and stop: the answers are not here yet.
  --batch-fetch           Take the answers of the submitted batches and go on.
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

Cost:
  A repaired fragment is a call to a picture model, and that is the most expensive
  part of the run. The fragments are asked for the cheap quality of their stage
  (stages.extend.quality, stages.reconstruct.quality, stages.overlap.quality —
  low by default), and every repaired fragment is checked before the next one:
  a repair the check refuses ends the screen there.

Config:
  Stored in ~/.ai-decompose/config.json.
  Environment variables prefixed with AI_DECOMPOSE_.
  Supports {{env:NAME}} substitutions.
  The picture hosts of imagesBackends are tried one by one; when all of them
  refuse the model, the next model of fallback.models gets the request.
  A host that refuses for the lack of money is remembered and skipped.
  The layer split is a route of its own: layerBackends names the hosts that
  serve seedream-5.5 (APIMart by default, key in APIMART_API_KEY), and
  stages.resolve.layerModel names the model. Without a key the text role
  splits the screen instead.

Batch:
  The hosts that serve the batch route carry the flag "supports": { "batch": true }
  in the config. Only the stages whose calls run in parallel are batched.
  The route is two-phase: --batch submits the requests of a round as one batch
  and stops (exit code 2), --batch-fetch takes the answers and goes on. The
  answers are kept in a journal under the output directory, so nothing is paid
  for twice. A batch that is not ready yet leaves the exit code 3.

Examples:
  ai-decompose -i screenshot.png
  ai-decompose -i collage.png --stages decompose,rectify
  ai-decompose -i original.png --advanced --out ./output
`;