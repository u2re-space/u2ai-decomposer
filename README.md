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
│  (Phase 0.5)     │  Any edge, several edges at once.
│                  │  → ./decomposition/extended/
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

### Running one stage on its own

A stage may be run alone, on the artifacts of the last run:

```bash
ai-decompose -i collage.png --stages reconstruct   # the restorer on the screens of the last run
ai-decompose -i collage.png --stages overlap       # the overlap on the restored screens
ai-decompose -i collage.png --stages resolve       # the final JSON of what is on the disk
```

The stages before it are not repeated — they cost money, and their answer is already written
down. The run takes the screens from the work directory of the last run (`decomposition/rectified`,
`decomposition/restored`, …), says where they came from and goes on:

```
  the screens of the last run are used: 3 file(s) from decomposition/rectified
```

Every stage writes what it produced into `decomposition/manifest.json`, so the names of the
screens and the files they ended up in survive the run. Without a manifest the pictures of the
directories are read instead, and the name of a screen is taken from the name of its file. A
directory keeps the pictures of every run that wrote to it, so only the newest batch of files is
taken — the files of the last run, written one after another.

The stage that cuts the screens is the one that cannot be skipped: without it there is nothing to
continue from, and the stage works on the pictures of `--image` instead.

## Architecture

### Roles (src/roles/*.js)

| Role | Stage | Purpose |
|------|-------|---------|
| `extender` | extend | Decide if the frame needs growing and on which edges; write the band instruction |
| `decomposer` | decompose | Name screens, crop/restore sub-references |
| `rectifier` | rectify | Place quad corners, call `correct_perspective` |
| `restorer` | reconstruct | Identify defects (leftover/missing/seam/artefact/rounded-corner), write patch instructions, name the tilt and the size of the screen |
| `overlap` | overlap | Compare screens, identify foreign elements in crops |
| `director` | resolve | Assemble final JSON, manage layers/advanced |

### Image Layer (src/image/*.js)

Sharp → Canvas → ImageMagick fallback chain:
- `raster.js`: crop, patch, decodeRgba, pad, compare, fit-to-box
- `rectify.js`: perspective correction, residual skew measurement
- `geometry.js`: rotation and size correction of the pixels, with the skew measured before and after
- `magick.js`: ImageMagick wrapper
- `padding.js`: canvas expansion
- `canvas.js`: node-canvas abstraction

### Growing the frame (extend)

The extend stage asks the `extender` role whether the frame cuts real content, and the role
names **every** edge that cuts it: `top`, `right`, `bottom`, `left` — one edge or several at
once. The source pixels keep their own scale and their own place in the new canvas (the
canvas is padded around them, not stretched), the editor paints only into the empty bands, and
the harness stitches the bands back over the untouched source, fading the seam along the side
that touches the picture. A picture cut at the top and at the bottom grows at both ends.

The band is an eighth of the long side (`stages.extend.padFraction`, 0.125 by default): enough
for a status bar or a row of buttons, not for another whole screen. A 1024×768 picture that is
cut at the top and at the bottom becomes 1024×1024.

### Falling back when a host refuses

Every request walks the hosts of its route — `backends` for a text answer, `imagesBackends` for
a picture, `layerBackends` for the layer split — and every host that refuses gives the request
to the next one. A host that refuses
because it has **no money** (`402`, `Insufficient balance`, `insufficient_quota`) is remembered
for the rest of the run and is not asked again: the next host takes the request and the run says
so:

```
  ⚠ the host https://api.proxyapi.ru/v1 has no balance: Insufficient balance to run this request. — the next host takes the request
```

When every host refuses the model — no balance, no route — the request goes to the next model of
`fallback.models`:

```json
{
  "fallback": {
    "enabled": true,
    "models": {
      "openai/gpt-image-2.6-sunburst": ["bytedance-seed/seedream-5-5"],
      "moonshotai/kimi-k3.1-pro": ["minimax/minimax-m3.1-flash"],
      "minimax/minimax-m3.1-flash": []
    }
  }
}
```

The key is the model that failed, the value is the list of models that get the request next. The
list works for the text route as well as for the picture route, so a run survives the loss of the
host that served the role. The run reports every step of the chain: `the model … failed — trying
…`.

The hosts themselves are listed in the config, and every one of them may name the environment
variable with its key:

```json
{
  "imagesBackends": [
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY" },
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" }
  ]
}
```

### Cutting a collage into screens

The `decomposer` names every screen of the picture and gives the rectangle of each one; the
`rectifier` places the four corners of every screen it sees. When a role names the corners but
does not write the file, the stage runs the projection itself — the projection is the cut, so
a collage of three phones becomes three screens even when the model forgot the tool call.

The corners belong to the **display area of the device**, not to the content inside it: a cut
made on a title or a card loses the margins of the screen, its status bar and its last row. The
role is told so, and the stage checks the result: after the cut, the role looks at the reference
and at the screens it produced and says whether a screen was cut off. A screen that lost its
edges is cut again, with wider corners (`stages.rectify.review`, on by default).

A screen gets up to `stages.rectify.maxAttempts` attempts (three by default), and every attempt is
projected from the **original picture**, never from a frame an earlier attempt produced: a
projection on top of a projection only adds the error of the first one. The best result of a
screen wins — the tilt is measured in the pixels, not judged by the model — and a result that is
worse than the one that is already kept is rolled back, so the screen keeps the bytes it had. A
screen stops trying as soon as an attempt does not bring it any closer to level, and a screen
that is already level is not asked again at all: there is nothing left to improve. The re-cut of
the review is an attempt as well and takes a part of the same budget.

Every accepted screen lands under a canonical name — the label of the screen and its number —
and the candidates of a round live in a scratch directory, so a later attempt never overwrites
the result that is already kept.

The collage is cut out of the **reference**, not out of the crops the `decomposer` made of it:
the reference is the ground truth of the picture, and a model that reads three tilted phones as
two flat screens cuts it in the wrong place. The rectifier works on the whole picture and names
the corners of every screen it holds; the crops of the reference are replaced by that cut. When
the reference cannot be cut, the crops are worked on as they are, so a good crop is never thrown
away. A sub-reference that was regenerated, repaired or exported from another source is never
treated as a crop — it carries work of its own and is worked on as it is.

One picture cut into several screens becomes several screens in `decomposition.json`: the chain
of the files follows every branch, so the answer names every screen of the collage.

### The AI mode of the rectify stage

`stages.rectify.mode` says who straightens the picture. The default, `geometry`, keeps the role
where it belongs: it names the four corners of every screen and the harness projects the pixels.
`ai-mode` puts the AI in front of the whole reference and keeps the geometry behind it:

1. **The AI straightens the reference first.** The reference is sent to the image editor as a whole
   picture, and the answer is measured: the residual tilt of the straightened picture has to be no
   worse than the tilt of the original. A straightening that does not flatten the reference is
   thrown away, and the stage goes on with the original bytes.
2. **The cut is still made by the geometry.** The screens are cut out of the straightened reference
   by the same corners and the same projection as in the `geometry` mode — the AI does not draw the
   screens, it only gives the geometry a better picture to cut.
3. **What is still broken is repaired by fragments.** The broken parts of a screen are named, cut
   out, sent to the editor one by one and stitched back into exactly their boxes; a repair that is
   not better than the picture it replaces is refused, and the screen keeps the bytes it had.
4. **The content of the neighbours is removed in the same stage.** The pieces of the neighbouring
   screens that came along with the cut are cleaned up here, so the separate `overlap` stage does
   not pay for the same work twice.

The mode is a setting of the stage:

```json
{
  "stages": {
    "rectify": {
      "mode": "ai-mode",
      "straightenAttempts": 1,
      "maxRepairPasses": 2,
      "maxPatches": 3,
      "boxPadding": 16,
      "quality": "low",
      "cleanOverlap": true
    }
  }
}
```

The same thing for one run only is the flag `--ai-mode`; it wins over the config file.

### Restoring a screen (reconstruct)

The restorer works in two halves, and the split is deliberate.

The **pixels** are the AI's part. The role names the damaged regions — a strip of a neighbour, a
bezel, a seam, and the **rounded corners of the display**: a corner that is cut round belongs to
the device, not to the content of the screen, so the content has to be continued into it. The
harness cuts the box, sends only that fragment to the editor, and stitches the answer back into
exactly that box; every pixel outside the box is copied from the untouched source. The repair is
then shown to the role again, side by side with the screen it replaces, and it is thrown away
unless the answer is better — a repair that redrew the lettering is worse than the defect it
removed.

The **geometry** is the harness's part. The role names the tilt of the content in degrees and
the size deviation in percent, and the harness turns those numbers into a rotation and a scale of
the pixels themselves (`image/geometry`): the picture is resampled once, with an inverse map, so
no glyph is redrawn and no element moves by hand. The canvas grows to the corrected picture —
nothing is cropped away — and the wedges the rotation opens are filled with the pixels of the
nearest edge.

The correction is judged by the measurement, not by the model: the residual tilt is measured
before and after, and the correction is rolled back when the screen did not become flatter. The
numbers the role gave are limits, not facts: a tilt above `stages.reconstruct.geometry.maxRotateDeg`
is refused with a warning instead of being applied quietly.

```
  geometry: 01-home.png — tilt 3°, size 0% (2.9° → 0.4°, applied)
```

### How many times the AI touches a screen

The restorer may come back to the same screen, but only a few times: `stages.reconstruct.maxPasses`
(three by default). A **pass** is the whole visit — the plan of the role and the repair of the
regions it named — so a screen costs at most three plans and three rounds of editor calls.

The first pass works on the **rectified** screen, the one the `rectify` stage produced, or on the
crop of the reference when there is no rectified result. Every later pass works on the result of the
repairs before it and is told which regions were repaired already, so the same box is never
repaired twice — the second answer to the same question would silently overwrite the first.

The editor itself is fed a fragment of the picture, and which picture that is depends on the model:
the `gpt-image` line redraws what it is given, so it is handed the fragment of the **rectified**
screen and never sees the pixels of an earlier repair; the `seedream` line keeps the pixels it is
given, so it may work on the repaired result and finish the job on it. The answer is stitched into
the working screen in either case.

### What a repair costs

Every fragment the editor is asked to fix is a call to a picture model, and that call is the most
expensive thing in the run. Two rules keep it down.

The **quality** of the answer is a setting of the stage, not of the run: a fragment is a strip of
background that is stitched back into one box, so the cheap quality is enough
(`stages.reconstruct.quality`, `stages.overlap.quality`, `stages.extend.quality` — `low` by
default). The global `image.quality` is used for the pictures the run generates, not for the
fragments it repairs.

The **check comes before the next repair**. Every repaired fragment is shown to the role again,
side by side with the screen it replaces, and a repair the check refuses ends the screen there:
the editor is not asked again for a screen that is already beyond repair. A screen that cannot be
fixed costs one call, not three.

The **number of passes is bounded**. The AI comes back to a screen at most
`stages.reconstruct.maxPasses` times (three by default), and a pass that names nothing new — the
screen is whole, or every region it names was repaired already — ends the screen there.

### What the run reports

Every stage says what it decided and what it produced — the edges that were grown, the screens
that were cut, the files that were projected, the layers that were found — and the run ends
with a summary:

```
Done.
  output: C:/out/decomposition.json
  screens: 3
    - home → decomposition/screens/01-home.png
    - transfer → decomposition/screens/02-transfer.png
    - articles → decomposition/screens/03-articles.png
  layers: 12
```

`decomposition.json` is written before the layer split, so the answer exists even when the
split is slow or fails.

### The layer split (advanced mode)

`--advanced` splits one screen into layers. There are two sources:

- `seedream` — the model of the layer route (`seedream-5-5`) splits the screen itself and answers
  with a base picture and transparent PNG layers, each with a bounding box. The base is written to
  `layers/00-base.png` and every layer to `layers/NN-<name>.png`. The model scales every layer on
  its own to the chosen tier, so the file of a layer is not the frame of its box: each file is
  brought to `w × h` of its box before it is written, and the box says where the layer belongs —
  `(x, y)` over the base.
- `director` — the text role names the layers with a box and the harness cuts those boxes out of
  the pixels of the screen.

`auto` (the default) picks `seedream` when the layer route can answer — its model is a seedream
one and a host of the route has a key — and `director` otherwise.

#### The layer route: APIMart

The layer split is a route of its own: the host that serves `seedream-5-5` is not the host that
repairs a picture, and the picture hosts do not know the model. The route is listed in
`layerBackends`, and the key is read from the environment variable the entry names:

```json
{
  "layerBackends": [
    { "baseURL": "https://api.apimart.ai/v1", "env": "APIMART_API_KEY" }
  ]
}
```

```
set APIMART_API_KEY=…
ai-decompose -i screen.png --advanced
```

The request is `POST https://api.apimart.ai/v1/images/generations` with
`layer_decomposition: true` and exactly one input image; the answer is a task, and the task is
polled on the same host (`GET /v1/tasks/{task_id}`) until it is `completed`. The layers come back
as transparent PNGs with a bounding box in the coordinates of the base picture.

Without the key the run does not fail: the text role splits the screen instead, and the run says
so (`no image backend of the layer route has a key — the text role splits the screen instead`).

### Batch (cheaper calls)

Some hosts serve the OpenAI batch route: a file of requests goes out as one batch, the host works
on it in the background, and the answers come back later. A batch costs about half the price of
the same requests one by one.

Only the stages whose calls run in parallel are batched — the `reconstruct` stage works on all
the screens at once, and the plan of every screen is one request of the round. A round of one
request is not a batch: it goes the usual way.

The route is two-phase, because the answers are not here when the requests go out:

```bash
ai-decompose -i collage.png --batch          # the requests go out as a batch, the run stops
ai-decompose -i collage.png --batch-fetch    # the answers are taken, the run goes on
```

The first run ends with the exit code 2 and the id of the batch; the second one ends with the
exit code 3 while the batch is not done yet (the host may need hours — the window is 24 h).

The two phases share a journal under the output directory (`decomposition/.batch`): every request
is named by the hash of its body, and every answer is kept under that name. The second phase asks
the same question and takes the answer from the journal instead of paying for it again. The bytes
of a picture edit are kept there too — an edit is not a part of a batch, but it sits between the
two phases of the run just the same.

A host takes part in a batch only when the config says so:

```json
{
  "backends": [
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY", "supports": { "batch": true } },
    { "baseURL": "https://sprutdock.ru/v1", "env": "SPRUTDOCK_API_KEY", "supports": { "batch": true } }
  ],
  "batch": { "enabled": false }
}
```

`batch.enabled` turns the route on for every run; the flags `--batch` and `--batch-fetch` turn it
on for one run. A batch that the host refuses is not the end of the run: the requests of that
batch go one by one after all.

### Config

- File: `~/.ai-decompose/config.json`
- Env prefix: `AI_DECOMPOSE_`
- Substitutions: `{{env:NAME}}`
- Backends, imagesBackends and layerBackends pools
- fallback.models: the models that get a picture request when every host refused the model

The section of the resolve stage:

| Field | Meaning |
|-------|---------|
| `layers` | Emit `layers/` next to `decomposition.json` |
| `maxLayers` | How many layers of one screen are kept |
| `layerSource` | `auto` \| `seedream` \| `director` |
| `layerModel` | The model of the layer route: `seedream-5-5` |
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
