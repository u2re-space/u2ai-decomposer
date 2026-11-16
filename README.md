# u2ai-decomposer

Multi-phase AI-agentic web-template (screenshot) image decomposer and restorer/extender.

- Named CLI as `ai-decompose`.
- Config in `~/.ai-decompose/config.json`.
- Node.js 26+, ESM, no SDK.

## Pipeline

The order of the stages is not fixed. A run that was not told which stages to run begins with
the **reception**: it looks at the picture and at the task and answers with the plan of the work
— the stages, their order and their parameters. The plan is written to `decomposition/plan.json`,
and the run follows it.

The plan may not break the laws of the house: `decompose` (the stage that cuts the screens) and
`resolve` (the stage that writes the answer) are always there, the stages that work on the
screens come after the one that cuts them, and `resolve` comes last.

The usual order — the fallback of a run without a plan — is the one below:

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
ai-decompose -i collage.png "cut this collage into screens and straighten them"
ai-decompose -i collage.png --stages decompose,rectify
ai-decompose -i original.png --advanced --out ./output
```

The task of the run is the prompt: `--prompt` or a positional argument. It is what the
reception reads when it decides what is going to be done to the picture.

### The reception and the plan

A run that was not told which stages to run begins with the reception. It gets the task and the
reference — the picture itself, not a description of it — and answers with the plan of the work:

- **steps** — the stages that are going to run, in the order they are going to run;
- **skipped** — the stages that are left out, and why they are not needed;
- **params** — the parameters of a stage: the quality of the answer of a stage that asks the
  picture model (`low`, `medium`, `high`), the mode of `decompose` (`agent`, `inline`), the mode
  of `rectify` (`geometry`, `ai-mode`), the number of passes of the restorer (`1..10`), the layer
  split of the resolve stage (`true`, `false`).

The plan is a draft, and the house checks it before the run follows it (`src/stages/plan.js`):

- a stage that does not exist is dropped, and a stage named twice is kept once;
- `decompose` and `resolve` are added back — without them there is nothing to continue from and
  nothing to deliver;
- the order is put right: `decompose` comes before the stages that work on the screens, and
  `resolve` comes last;
- a parameter that is not in the table of the stage is dropped with a warning, and a value that
  is not one of the allowed ones is dropped too.

The parameters of the plan are written into the **copy** of the settings of the run — the config
of the user is never touched. The plan itself is written to `decomposition/plan.json`:

```json
{
  "summary": "Three screens in one photo: cut them out and straighten them.",
  "prompt": "cut this collage into screens and straighten them",
  "steps": [
    { "stage": "decompose", "why": "three screens", "params": {} },
    { "stage": "rectify", "why": "the photo is tilted", "params": { "mode": "geometry" } },
    { "stage": "resolve", "why": "the answer", "params": {} }
  ],
  "skipped": [
    { "stage": "extend", "why": "nothing is cut through" },
    { "stage": "reconstruct", "why": "nothing is broken" },
    { "stage": "overlap", "why": "one screen" }
  ],
  "notes": []
}
```

The reception has no tools at all: it plans the work, it does not do it. When it answers
nothing, the run falls back to the usual work — every stage, in the usual order, with the
settings of the config — and says so.

`plan.enabled: false` in the config turns the reception off for good; `plan.maxTurns` is the
budget of the role (4 by default).

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

### The access layer (src/access)

`src/access` is the door between the model and the machine: the files and the commands under one
root. Both halves work through a backend, so the same rules hold on a native disk, in the memory,
or over a remote one.

```js
import { createAccess } from './src/access/index.js';

const access = createAccess({ root: process.cwd() });

await access.fs.writeText('notes/todo.md', '# todo');
const found = await access.fs.search({ query: 'todo' });

const listing = await access.fs.listFiles('src', { depth: 2, limit: 400 });
const copied = await access.fs.copy('src/app.js', 'lib/app.js');
const answer = await access.exec.run('node', ['--version']);
```

The rules of the paths live in one place and are never optional: a path may not leave the root —
neither through `..` nor through a symbolic link — the secret files and the secret directories are
never accessible, and the read-only directories may be read, but never written. `src/agent/paths.js`
keeps the words of the refusals and borrows the rules from `src/access/paths.js`.

`listFiles` returns the tree of a path as the model reads it: the noisy folders are marked and
not opened, the dot-files are hidden unless they are asked for, the sizes are in the text, and a
path that does not exist yet answers with the nearest existing parent. `copy` copies a file or a
tree under the same rules: no secret, no symbolic link, no directory into itself, and the
destination must not exist unless `overwrite` is asked for.

### Roles (src/roles/*.js)

| Role | Stage | Purpose |
|------|-------|---------|
| `reception` | — | Read the task and the reference, answer with the plan of the work |
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
- `angles.js`: the turn, the shear and the squeeze of a picture, in degrees
- `matrix.js`: the projective matrix of 3×3 or 4×4, and the warp that runs on it
- `distort.js`: the homography and the bilinear warp of a quad
- `magick-cli.js`: the free command line of ImageMagick and the rules around it
- `magick-docs.js`: the manual of ImageMagick, written for a role
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
      "google/gemini-4-hydrogen": ["moonshotai/kimi-k3.1-pro", "minimax/minimax-m3.1-flash"],
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

The chain of the house is the Kimi: it answers with the reasoning off in a fraction of the time,
so a run that met a refusal keeps going. The Kimi is the fallback of the Gemini and of every
other text model.

The profiles of the text models are tuned by the cards of the gateway (RouterAI, November 2026)
and by the live answers of it:

| Model | Context | Output | Ceiling | Ladder |
|---|---|---|---|---|
| `google/gemini-4-hydrogen` | 1M tokens (4 MiB) | 1M | `xhigh` | `low`, `medium`, `high`, `xhigh` |
| `minimax/minimax-m3.1-flash` | 1M tokens (4 MiB) | 524K | `xhigh` | `low`, `medium`, `high`, `xhigh` |
| `moonshotai/kimi-k3.1-pro` | 1M tokens (4 MiB) | 944K | `medium` | `none`, `low`, `medium` |

The Gemini decodes up to 1M tokens with the continuation and takes the effort up to `xhigh`; the
card of the vendor names the four levels of its effort and has no `none`, so the reasoning off is
raised to `low`. The Kimi keeps the reasoning off without a refusal and answers in a fraction of
the time, so `none` stays on its ladder — the levels above `medium` cost the same seconds, and
`medium` is its ceiling.

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

### The angles of a picture and the matrix that corrects it

The rectifier does not say "a bit tilted": it says **how many degrees**. A tilt of 2.4° and a
tilt of 0.2° are two different pictures, and only one of them needs another attempt, so the
role is asked for numbers that can be checked against the pixels of the result.

Three numbers describe the geometry of a screen:

| Angle | What it is | How it is measured |
|-------|-----------|-------------------|
| `rotation` | The turn of the picture — how far it is clockwise | The mean tilt of the two horizontal edges |
| `skew` | The shear — how far the two horizontal edges disagree | The difference of the two edge angles |
| `keystone` | The squeeze of the perspective — how far the two vertical edges disagree | The difference of the two edge angles |

The sign is the one of the picture itself: positive means the content runs downhill to the
right, that is, clockwise on the screen. The numbers are measured on the corners the role
named (`quadAngles`) and on the matrix it named (`matrixAngles`), and they are kept in the
report of the stage — in `rectify.file`, in the accepted entries of the state and in the
output of the run:

```
  rectified: decomposition/rectified/01-home.png (home) — turned 2.4°, skewed 0.6°, residual 0.3°
```

The **matrix** is the other way of saying the same thing. The four corners say where four
points go; a matrix says where *every* point goes. When the whole picture is turned, squeezed
or scaled, the corners of one screen have nothing to say — the matrix says it in nine numbers.

- The matrix is read as **source → destination**: it maps the pixels of the source onto the
  result. The harness inverts it and samples the source with bilinear weights, so the pixels
  that end up in the result are the pixels that were there — no resampling by a model.
- A **3×3** matrix is the homography itself. A **4×4** matrix acts on the column `(x, y, 0, 1)`:
  the third coordinate is zero, the fourth is one, and the point of the result is
  `(q₀/q₃, q₁/q₃)`. The 4×4 matrix is the 3×3 homography with the translation in the last
  column, and the conversion is exact.
- The frame of the result is the frame the matrix gives the picture: the corners of the source
  mapped through the matrix, and the picture framed on what it becomes. A turn therefore leaves
  the empty corners of the turn transparent, and a scale grows the picture as the matrix says.

The role reaches the matrix through the tool **`apply_matrix`** (the switch
`tools.image_apply_matrix`, on by default), and it may also name the matrix in its answer:
the entry of a screen in `RECTIFY_SCHEMA` carries either the four corners or the matrix, and
the stage runs the warp on the one it was given.

```
apply_matrix — path, matrix_json (9 or 16 numbers, row major), output
→ Warped by a 3×3 matrix → decomposition/rectified/01-home.png (214×150, turned 2.4°, skewed 0.6°, residual tilt 0.3°)
```

The rule of the house stays the same either way: a copy is kept only when the tilt that is
left in its pixels is smaller than the tilt of the picture it replaces.

### The free ImageMagick

The tools of the house are narrow on purpose: a crop, a split, a projection. But a picture is a
wide thing, and there are operations that no narrow tool covers: `-deskew` straightens a picture
that was shot at an angle, `-distort Perspective` puts a quadrilateral back into a rectangle,
`-trim` cuts the frame away, `-deskew` and `-morphology` clean a scan. So the roles that work on
a picture are given **ImageMagick itself**.

Two tools carry it:

| Tool | What it does |
|------|--------------|
| `magick` | Runs a command of ImageMagick. The arguments are the ones of the command line, one argument per element, without the word `magick` |
| `magick_help` | Gives the manual: the rules of the command line, the operators, the distort methods |

The roles that work on a picture get them — the extender, the decomposer, the rectifier and the
restorer. The roles that *judge* a picture (the verifier of a repair, the repairer of a broken
cut) do not: they have nothing to straighten.

```
magick — args: ["in.png", "-distort", "Perspective", "0,0 0,0 69,0 0,69", "out.png"]
→ ImageMagick: exit 0
  The result is written to out.png
```

The rules of the house stand around the free command line:

1. **No shell.** The command is started with an array of arguments, so a path with a space or a
   quote in it cannot become a second command.
2. **The paths stay inside the run.** Every path of the command is resolved against the root of
   the run; a path that leaves it — through `..` or through a symlink — is refused. The file that
   is written has to land in a directory the stage opened for writing (`decomposition/screens/`
   for the decomposer, the scratch of the stage for the rectifier).
3. **The protocols are refused.** `msl:` runs a script, `http:` reads from the network, `file:`
   names a file outside of the run. The harmless ones stay: `xc:` is a canvas of one colour,
   `png:compression-level=9` is a setting of the format.

A command that fails is not an error of the run: the exit code and the words of stderr are the
answer, and the model reads them.

The manual is measured, not remembered: the number of the control points of every distort method
was read off ImageMagick 7.1.2-34 (`Affine` — 3 pairs, `Perspective` — 4 pairs, `Shepards` — any
number of pairs, `Polynomial` — an order and at least 6 pairs), and the addresses of the full
manual are in it: [usage.imagemagick.org](https://usage.imagemagick.org/),
[the distort methods](https://usage.imagemagick.org/distorts/),
[the command line processing](https://imagemagick.org/command-line-processing/).

The switch `tools.image_magick` (on by default) turns both tools off.

### The CLIs of the house

The tools of the house are narrow on purpose: a crop, a split, a projection, a patch. But the
neighbours of the house are wide: `ai-image` makes and cuts pictures (`resize`, `trim`, `pad`,
`alpha`, `background`, `vectorize`, `info`), `ai-measure` measures them, and both know commands
and flags that no narrow tool of this package covers. A role that needs one of them has nowhere
to go — so the family gets a free door: the tool `ai_cli`.

| CLI | What it does |
|---|---|
| `ai` | The umbrella: ask, chat, run, gen, image, decompose, component, serve, mcp. |
| `ai-webdev` | The web project: the plan, the stages, the roles. |
| `ai-decompose` | This CLI: splits a reference into screens and fragments. |
| `ai-measure` | Measures a reference: the frames, the gaps, the sizes, the colours. |
| `ai-image` | Makes the pictures of the project and cuts them. |

A call names the CLI and the arguments of its command line, one argument per element:

```json
{"cli": "ai-image", "args": ["--help"]}
{"cli": "ai-image", "args": ["info", "screens/01-home.png"]}
{"cli": "ai-measure", "args": ["measure", "landing.png", "--out", "measurements"]}
```

The rule of the house about the flags is one line: **ask the CLI**. Every CLI of the family
answers `--help` with the whole table of its commands and its flags, and `--version` with its
version. The help is a local text — it calls no model and costs nothing, while a guessed flag
costs a failed call and a wasted turn. The manual of the family — which CLI does what, the flags
they share, the flags and the commands of every one of them — is in the tool `ai_cli_help`.

The roles that work on a picture get the door — the extender, the decomposer, the rectifier, the
restorer and the overlap resolver. The roles that *judge* the run (the reception, the director)
do not: they have nothing to ask of a CLI.

The rules of a free call are the rules of every tool of the house:

1. **No shell.** The command is started with an array of arguments, so a path with a space or a
   quote in it cannot become a second command. A shim of Windows is a batch file, and it is
   started through the shell of the system — with the arguments quoted for it.
2. **The paths stay inside the run.** Every path of the command is resolved against the root of
   the run; a path that leaves it is refused. The file that is written has to land in a
   directory the stage opened for writing.
3. **A command that does not finish on its own is refused.** A server or a watcher would hold the
   run until the timeout and bring nothing.

The binary of a CLI is looked up in the environment variable of the CLI (`AI_BIN`,
`AI_WEBDEV_BIN`, `AI_DECOMPOSE_BIN`, `AI_MEASURE_BIN`, `AI_IMAGE_BIN`), in the checkout of the
sibling package, in `node_modules` and in the `PATH`. The switch `tools.external_cli` (on by
default) turns both tools off.

A role that calls a CLI needs more than one turn: it asks, it reads the answer, it decides. The
budget of the turns of the three stages that gained the door — `stages.extend.maxTurns`,
`stages.reconstruct.maxTurns`, `stages.overlap.maxTurns` — is four by default, and the ceiling of
the house (`limits.maxPossibleTurns`, sixteen) still holds above it.

### The AI mode of the rectify stage

The mode says who straightens the picture. `geometry` keeps the role where it belongs: it names
the four corners of every screen and the harness projects the pixels. `ai-mode` puts the AI in
front of the whole reference and keeps the geometry behind it:

1. **The AI straightens the reference first.** The reference is sent to the image editor as a whole
   picture, and the answer is measured: the residual tilt of the straightened picture has to be no
   worse than the tilt of the original. A straightening that does not flatten the reference is
   thrown away, and the stage goes on with the original bytes. The straightened pictures live in
   `decomposition/straightened/` — the reference itself is never overwritten.
2. **The cut is still made by the geometry.** The screens are cut out of the straightened reference
   by the same corners and the same projection as in the `geometry` mode — the AI does not draw the
   screens, it only gives the geometry a better picture to cut.
3. **What is still broken is repaired by fragments.** The broken parts of a screen are named, cut
   out, sent to the editor one by one and stitched back into exactly their boxes; a repair that is
   not better than the picture it replaces is refused, and the screen keeps the bytes it had. For
   every region the role says where the pixels come from: the **screen** itself, or the
   **reference** — a region of the reference is found through the same homography the screen was
   cut by, so a piece that the geometry mangled can be taken from the original picture instead of
   from the cut. The repaired screens live in `decomposition/repaired/`; the result of the geometry
   stays where it is, and the run points at the repaired file.
4. **The content of the neighbours is removed in the same stage.** The pieces of the neighbouring
   screens that came along with the cut are cleaned up here: the screens are compared side by
   side, the foreign regions are named, cut out, cleaned and stitched back into their boxes. The
   cleaned screens live in `decomposition/overlap/`, and the run points at them. The separate
   `overlap` stage of the pipeline sees that the work is done and skips it, so the same cleaning
   is not paid for twice. The knob `stages.rectify.cleanOverlap` (`true` by default) turns the
   step off — then the separate stage does the work as usual.

The mode is a setting of the stage, and the plan of a run may name a mode of its own:

```json
{
  "stages": {
    "rectify": {
      "mode": "auto",
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

`auto` is the default. The plan decides the mode of a run; without a plan the run asks the
picture model when there is one (`ai-mode`) and falls back to the geometry when there is not
(`geometry`). The value of the config is the fallback of the runs that were not planned — the
plan of a run wins over it.

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

The split happens only when somebody asked for it: `--advanced`, or `stages.resolve.layers` is
`true` in the config, or the plan of the run asks for the layers **and** the task says so in
words (`layers`, `layered`, «послойно», «слои»). A plan that asks for the split on its own is
refused, with a warning: the split is expensive and it changes the shape of the delivery.

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

## The house of the project

Every project has one directory of its own: `.ai/`. Everything a run makes that is not the
product itself lives there, and nowhere else.

```
.ai/
  tmp/<run-id>/     the state of the run: the scratch of the stages
  assets/           the assets of the house
  logs/api/         the log of the API calls
  manifest.json     the contract of the project: what every system made and where it lies
```

The state of a run dies with the run: a new run never reads the state of the old one, and the
old one never gets in the way of the new one. The `output.work` of the config may move the
state elsewhere, but there is only one path, and it is computed in one place — the house.

The delivery stays where the user expects it: `decomposition/` with the directory of every
stage inside it, and `decomposition.json` next to it. The house keeps the state and the
contract, and it does not move the delivery. The scratch of the stages — the candidates of a
projection, the fragment of a repair, the band of an extension — is the state of the run, not
a part of the product: it lives in `.ai/tmp/<run-id>/` and dies with the run. The delivery
keeps the product alone.

The contract is how the systems of the house find each other. Every system signs its own part
of `.ai/manifest.json` and never touches the part of another one:

```json
{
  "manifestVersion": 1,
  "updatedAt": "2026-11-15T03:41:02.113Z",
  "systems": {
    "decomposer": {
      "delivery": "decomposition/",
      "artifacts": {
        "decomposition": "decomposition.json",
        "manifest": "decomposition/manifest.json",
        "screens": "decomposition/screens/",
        "extended": "decomposition/extended/",
        "rectified": "decomposition/rectified/",
        "restored": "decomposition/restored/",
        "overlap": "decomposition/overlap/",
        "repaired": "decomposition/repaired/",
        "straightened": "decomposition/straightened/"
      },
      "runId": "mwf29yjp-89134d",
      "screens": 3,
      "updatedAt": "2026-11-15T03:40:58.002Z"
    }
  }
}
```

The paths are relative to the project and with forward slashes: the contract is read on another
machine and another system, and the path has to mean the same thing there. A run reads the
contract first and only then the old paths of the config, so a delivery that moved is still
found.

The files of the house are written whole: the bytes go to a file next to the target and the
target is replaced by a rename. A reader never sees half of a file, and a run that dies in the
middle leaves the old file and not a broken one.

### Config

- File: `~/.ai-decompose/config.json`
- Env prefix: `AI_DECOMPOSE_`
- Substitutions: `{{env:NAME}}`
- Backends, imagesBackends and layerBackends pools
- fallback.models: the models that get a picture request when every host refused the model
- output.work: where the state of a run goes: `.ai/tmp/` by default. It dies with the run.
- plan.enabled / plan.maxTurns: the reception of the run and its budget
- limits.maxPossibleTurns: the ceiling of the turns of one role call

The limits of the house:

| Field | Meaning | Default |
|-------|---------|---------|
| `maxPossibleTurns` | The ceiling of the turns of one role call: the budget of a stage may not go past it, so a role that keeps asking for tools cannot spin the run forever | `16` |
| `stageTimeoutMs` | The wall-clock budget of one stage | `900000` |
| `requestRetries` | The retries of one API request | `3` |

The ceiling comes from the environment as well: `AI_DECOMPOSE_MAX_POSSIBLE_TURNS` (the old name
`AI_DECOMPOSE_MAX_TURNS` still works).

The section of the plan:

| Field | Meaning | Default |
|-------|---------|---------|
| `enabled` | Ask the reception for the plan of the run before the pipeline starts | `true` |
| `maxTurns` | The budget of the reception role | `4` |

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

## Development

```bash
npm test               # the whole suite, offline
npm pack --dry-run     # what the package would publish
```

The suite is offline: `test/offline-guard.js` refuses every address outside the machine, so
a test that reaches the outside fails fast instead of spending money.

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
