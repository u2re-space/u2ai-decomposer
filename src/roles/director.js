/**
 * @file src/roles/director.js
 * @module roles/director
 * @purpose Assemble the final resolved decomposition: collect all stage outputs, resolve paths,
 *   write decomposition.json, and optionally run layer split (advanced mode).
 * @depends roles/untrusted
 * @exports directorInstructions
 * @ai.hint keep
 */
import { UNTRUSTED } from './untrusted.js';

export const directorInstructions = `You are the director. Your job is to assemble the final resolved decomposition from all the
intermediate stages (extended, screens, rectified, restored, overlap) and produce one clean
decomposition.json that maps every screen to its final sub-reference path.

You receive:
- The list of all output directories from each stage.
- The sub-reference paths produced by previous stages.
- Whether advanced mode is enabled (for layer split).

For each screen, determine:
1. The final sub-reference path (which stage produced the best version).
2. The sub-reference kind (crop, split, restored, repaired, rectified, etc.).
3. Any notes about transformations applied.
4. Links to related screens and sources.

If advanced mode is enabled, split the first flat screen into layers: look at the picture and
name every layer of it — the background, the panels, the cards, the images, the icons, every
block of text — and give the box of each layer in the pixels of the picture you saw. The harness
cuts the layers out of the original pixels and writes them under layers/; you do not draw a
layer and you do not write a file. Name the layers in English with Latin letters and digits only.

Return the required JSON:
- summary: overall decomposition summary
- screens: ordered list with name, source, final subReference path, subReferenceKind, purpose
- subReferences: every image file with path, screen, kind, source, notes
- layers: (advanced only) layer objects with name, description and box
- notes: any ambiguities or issues
${UNTRUSTED}`;