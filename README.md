# u2ai-decomposer

Multi-phase AI-agentic web-template (screenshot) image decomposer and restorer/extender.

- Named CLI as `ai-decompose`.
- Config in `~/.ai-decompose/config.json`.
- Node.js 26+, ESM, no SDK.

## Pipeline

Six stages run in sequence, each producing artifacts in `./decomposition/`:

```
original.png
    │
    ▼
┌─────────────────┐
│  0. extend       │  Grow reference frame if content is cut through real content.
│  (Phase 0.5)     │  → ./decomposition/extended/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  1. decompose    │  Split reference into ordered screens with sub-references.
│  (crop to        │  → ./decomposition/screens/
│   screens)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. rectify      │  Un-rotate / recover projection, cut collages into screens.
│  (Phase 1)       │  → ./decomposition/rectified/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. reconstruct  │  Restore lost details via AI box-patch and verify.
│  (Phase 1.5)     │  → ./decomposition/restored/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. overlap      │  Remove overlapping elements from/by other screens (AI).
│  (new)           │  → ./decomposition/overlap/
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  5. resolve      │  Assemble final decomposition.json + layers (advanced).
│  (final)         │  → ./decomposition.json + layers/
└─────────────────┘
```

## Usage

```bash
ai-decompose -i screenshot.png
ai-decompose -i collage.png --stages decompose,rectify
ai-decompose -i original.png --advanced --out ./output
```

## Architecture

### Roles (src/roles/*.js)

| Role | Stage | Purpose |
|------|-------|---------|
| `extender` | extend | Decide if frame needs growing; write band instruction |
| `decomposer` | decompose | Name screens, crop/restore sub-references |
| `rectifier` | rectify | Place quad corners, call `correct_perspective` |
| `restorer` | reconstruct | Identify defects (leftover/missing/seam/artefact), write patch instructions |
| `overlap` | overlap | Compare screens, identify foreign elements in crops |
| `director` | resolve | Assemble final JSON, manage layers/advanced |

### Image Layer (src/image/*.js)

Sharp → Canvas → ImageMagick fallback chain:
- `raster.js`: crop, patch, decodeRgba, pad, compare, fit-to-box
- `rectify.js`: perspective correction, residual skew measurement
- `magick.js`: ImageMagick wrapper
- `padding.js`: canvas expansion
- `canvas.js`: node-canvas abstraction

### The layer split (advanced mode)

`--advanced` splits one screen into layers. There are two sources:

- `seedream` — the image model (`seedream-5-5`) splits the screen itself and answers with a base
  picture and transparent PNG layers, each with a bounding box. The base is written to
  `layers/00-base.png` and every layer to `layers/NN-<name>.png`. The model scales every layer on
  its own to the chosen tier, so the file of a layer is not the frame of its box: each file is
  brought to `w × h` of its box before it is written, and the box says where the layer belongs —
  `(x, y)` over the base.
- `director` — the text role names the layers with a box and the harness cuts those boxes out of
  the pixels of the screen.

`auto` (the default) picks `seedream` when the configured image model is a seedream one and
`director` otherwise.

### Config

- File: `~/.ai-decompose/config.json`
- Env prefix: `AI_DECOMPOSE_`
- Substitutions: `{{env:NAME}}`
- Backends and imagesBackends pools

The section of the resolve stage:

| Field | Meaning |
|-------|---------|
| `layers` | Emit `layers/` next to `decomposition.json` |
| `maxLayers` | How many layers of one screen are kept |
| `layerSource` | `auto` \| `seedream` \| `director` |
| `layerSize` | The tier of the seedream decomposition: `auto` \| `1K` \| `1.5K` \| `2K` |
| `textRecognition` | Ask the model for the OCR of the text layers |
| `layerPrompt` | The prompt of the decomposition (the tight-box wording by default; `""` sends no prompt) |

### Progress and long requests

A stage of the pipeline may take minutes: a reasoning model reads a picture, a picture
model paints a band. The CLI keeps a live line under the stage header — what the model is
doing right now and how long it has been doing it:

```
▶ Extend reference
⠹ the extender role is answering (moonshotai/kimi-k3.1-pro) · 1 m 12 s
```

The roles ask for a streamed answer, so the host keeps sending events while the model
thinks. Retries, a host that fell out and a host that refuses the stream are printed,
not hidden. When the output is piped, the same events are written as plain lines.

| Field | Meaning | Default |
|-------|---------|---------|
| `timeoutMs` | The window of silence the text host may keep (5 000…600 000 ms) | `600000` |
| `imageTimeoutMs` | The same window for the image route (5 000…1 800 000 ms) | `900000` |
| `streaming` | Ask the roles for a streamed answer | `true` |

The windows are stalls, not budgets: a streamed answer keeps the connection awake while
the model thinks, and a picture comes in one piece, so the image route gets a longer
window. The env names are `AI_DECOMPOSE_TIMEOUT_MS`, `AI_DECOMPOSE_IMAGE_TIMEOUT_MS` and
`AI_DECOMPOSE_STREAMING`.

## Lineage

The phases were ported from the monolith `Universal-AI` (0.2.xx), where they lived in
`archive/reference-phases/` and failed inside the agent flow: an image editor has no stable contract
for "grow this frame", the role refused to name the corners of a skewed photo, and the seam of a
generative answer was never the source. Here they are the pipeline itself, each stage with its own
role, its own directory and its own tests.

The files that came from the monolith carry `@ai.hint legacy-0.2` in their header: the openai layer,
the image layer, the agent layer, the roles and the three stages that grew out of the archived
phases. The files written for this package do not.

The monolith reaches this package through one command: `ai decompose` delegates to `ai-decompose`.

```bash
npm i -g @u2ai/decomposer     # or: AI_DECOMPOSE_BIN=/path/to/ai-decompose.js
ai decompose --image collage.png
```

The monolith looks for the binary in `AI_DECOMPOSE_BIN`, in `submodules/u2ai-decomposer`, in
`node_modules/@u2ai/decomposer` and in `PATH`.
