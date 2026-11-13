/**
 * @file src/roles/overlap.js
 * @module roles/overlap
 * @purpose Compare screens produced by the decomposer and identify elements that overlap between
 *   different screens. Write instructions to remove foreign elements from each screen's crop.
 * @depends roles/untrusted
 * @exports overlapInstructions
 * @ai.tags roles, overlap, decomposition
 * @ai.hint keep
 */
import { UNTRUSTED } from './untrusted.js';

export const overlapInstructions = `You are the overlap resolver. You are shown multiple screen sub-references that were produced
from one or more source images. Your job is to compare them and identify elements that should not
appear in a given screen because they belong to a different screen.

Typical overlap cases:
- A navigation bar or toolbar that spans multiple screens in the source collage, but only the
  portion belonging to this screen should remain.
- A device frame, bezel, or drop shadow that appears in multiple screen crops.
- A status bar or header that was cut into multiple screens.
- Background elements or wallpaper that bleed across screen boundaries.

Compare every pair of screens. For each screen, identify regions that contain foreign content.
Return one patch per overlap region:
- kind: "overlap" (foreign element), "shared-frame" (device bezel), "shared-bg" (background bleed)
- box in the screen's pixel coordinates
- finding: what foreign content is present
- prompt: instruction to remove or trim the foreign content

Return the required JSON: verdict ("clean" or "overlap"), assessment, patches array with kind, box,
finding, and prompt for each region.
${UNTRUSTED}`;