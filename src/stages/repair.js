/**
 * @file src/stages/repair.js
 * @module stages/repair
 * @purpose The two calls that every targeted repair makes: the editor that fixes one fragment, and
 *          the second look that decides whether the answer is worth keeping.
 *
 *   Both stages that repair a picture — reconstruct and overlap — cut a box, send only that
 *   fragment to the editor, and stitch the answer back into exactly that box. The editor call and
 *   the check that follows it are the same in both, so they live here: one place decides how
 *   hard the editor is asked to work (the quality of the answer) and one place decides whether a
 *   repair is kept.
 *
 * @depends node:fs/promises, openai/images, openai/responses, roles/index
 * @usedBy stages/reconstruct, stages/overlap
 * @exports editFragment, verifyRepair
 * @ai.tags restoration, editor, verification
 * @ai.hint io
 */

import { readFile } from 'node:fs/promises';
import { RESTORE_VERIFY_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { sniffImage } from '../openai/images.js';
import { imagePart } from '../openai/responses.js';

/**
 * Send one fragment to the image editor and wait for an answer.
 *
 * The fragment is small and it is stitched back into one box, so the quality of the answer is a
 * stage setting rather than the global one: a `high` answer costs several times more and buys
 * nothing on a strip of background.
 * @param {{ client: object, editorModel: string, prompt: string, filename: string, bytes: Buffer,
 *   maxAttempts?: number, quality?: string|null, format?: string }} params
 * @returns {Promise<Buffer|null>} the edited bytes, or null when the editor did not answer
 * @ai.hint io
 */
export async function editFragment({
    client, editorModel, prompt, filename, bytes, maxAttempts = 2, quality = null, format = 'png',
}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const answer = await client.images.edit({
                model: editorModel,
                prompt,
                format,
                quality: quality ?? undefined,
                image: { filename, mime: sniffImage(bytes).mime, bytes },
            });
            if (!answer?.images?.length) throw new Error('the editor returned an empty answer');
            return answer.images[0].bytes;
        } catch {
            if (attempt >= maxAttempts) return null;
        }
    }
    return null;
}

/**
 * Ask whether the repaired file is better than the one it would replace.
 *
 * Anything but a clean "better" keeps the original: a repair that redrew the lettering is worse
 * for measurement than the defect it removed, and the measurer cannot tell the two apart.
 * @param {{ roles: object, before: string, after: string, root: string, model: string|null,
 *   effort: string|null }} params
 * @returns {Promise<{ verdict: string, reason: string }>}
 * @ai.hint io
 */
export async function verifyRepair({ roles, before, after, root, model, effort }) {
    const [first, second] = await Promise.all([readFile(before), readFile(after)]);
    const resolved = roles.resolve?.('restorerVerify');
    const result = await roles.run('restorerVerify', {
        text: 'BEFORE is the first image, AFTER is the second. Which should the measurer use?',
        parts: [imagePart(first, sniffImage(first).mime), imagePart(second, sniffImage(second).mime)],
        instructions: resolved?.instructions ?? ROLE_INSTRUCTIONS.restorerVerify,
        schema: RESTORE_VERIFY_SCHEMA,
        schemaName: 'restoreVerdict',
        maxTurns: 1,
        model,
        effort,
    });
    if (!result?.data?.verdict) {
        return { verdict: 'worse', reason: `the verification did not answer (${result?.status ?? 'unknown'})` };
    }
    return { verdict: result.data.verdict, reason: String(result.data.reason ?? '').trim() };
}
