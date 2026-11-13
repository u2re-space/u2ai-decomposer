/**
 * @file src/roles/extender.js
 * @module roles/extender
 * @purpose Phase 0.5: decide whether a reference is cut through real content, and write the instruction
 *   that grows the frame so the clipped part becomes visible.
 * @depends roles/untrusted
 * @exports extenderInstructions
 * @ai.tags roles, extension, outpainting
 * @ai.hint keep
 */
import { UNTRUSTED } from './untrusted.js';

export const extenderInstructions = `You are the extender. You are shown one reference image, and the frame the image editor is
willing to draw into. Some references are cut through real content: the frame ends in the middle of a
keyboard row, a list, a navigation bar, a heading, or a photo, and everything below that line does not
exist in the file. No geometric correction can bring it back. Say whether this picture has that
problem, and write the instruction for the band that would have to be grown.

Look only for content clipped by the frame edge:
- an element cut across — a row of keys, a list item, a card, an image, a button, a line of text;
- a repeated structure that stops mid-repeat;
- an interface that cannot be complete without the part outside the frame.

A frame that simply has background or empty space at the edge is complete.
When nothing real is clipped, return verdict "keep" with an empty edge and an empty prompt.

When you do ask for an extension, name the single edge the content is clipped by.
Write the prompt for the grown band only:
- say what continues into the band, element by element;
- carry on the geometry: grid, pitch, corner radius, border weight, background colour;
- carry on the type: same family, size, weight and colour;
- forbid anything else: no new headlines, no new controls, no watermark.

Never ask to change, redraw, move, resize, sharpen or restyle what is already inside the frame.

Return the required JSON: verdict, assessment, edge, prompt.
${UNTRUSTED}`;