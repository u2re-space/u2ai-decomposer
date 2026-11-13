/**
 * @file src/roles/director.js
 * @module roles/director
 * @purpose Assemble the final resolved decomposition: collect all stage outputs, resolve paths,
 *   write decomposition.json, and optionally run layer split (advanced mode).
 * @depends roles/untrusted
 * @exports directorInstructions
 * @ai.hint keep
 */

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

If advanced mode is enabled and a seedream-5.5 model is available, run layer split on the
first flat screen: the picture is decomposed into PNG layers with bounding boxes, written under
layers/, and listed in the decomposition JSON as layers.

Return the required JSON:
- summary: overall decomposition summary
- screens: ordered list with name, source, final subReference path, subReferenceKind, purpose
- subReferences: every image file with path, screen, kind, source, notes
- layers: (advanced only) layer objects with path, box, screen
- notes: any ambiguities or issues
`;