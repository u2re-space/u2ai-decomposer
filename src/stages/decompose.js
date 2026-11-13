/**
 * @file src/stages/decompose.js
 * @purpose Stage: crop reference into screens (decomposer role).
 * @exports runDecompose
 * @ai.hint keep
 */
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { DECOMPOSER_SCHEMA } from '../agent/schemas.js';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { collectSubReferences, decompositionReport } from '../agent/decomposition.js';

/**
 * Run the decompose stage.
 * @param {object} state
 * @param {Function} notify
 */
export async function runDecompose(state, notify = () => {}) {
    const { root, images, workDir, config, roles, model, effort, dryRun, warnings } = state;
    if (!images.length) {
        warnings.push('decompose: no images to process');
        return;
    }

    const screensDir = path.join(root, workDir, 'screens');
    await mkdir(screensDir, { recursive: true });

    // Build parts from images.
    const parts = [];
    for (const img of images) {
        const abs = path.resolve(root, img);
        try {
            const bytes = await readFile(abs);
            parts.push({ type: 'input_image', source: { type: 'base64', data: bytes.toString('base64'), media_type: 'image/png' } });
        } catch {
            warnings.push(`decompose: cannot read ${img}`);
        }
    }

    const result = await roles.run('decomposer', {
        text: `References: ${images.join(', ')}\nOutput directory: ${workDir}/screens/\nSplit these references into distinct screens and produce one clean sub-reference image for each.`,
        parts,
        instructions: ROLE_INSTRUCTIONS.decomposer,
        schema: DECOMPOSER_SCHEMA, schemaName: 'decomposition',
        maxTurns: config.stages?.decompose?.maxTurns ?? config.limits?.maxTurns ?? 32,
        model, effort,
    });

    if (!result.data) {
        warnings.push(`decompose: role returned no data (${result.status})`);
        return;
    }

    state.decomposition = result.data;
    state.screens = result.data.screens ?? [];

    // Collect sub-references.
    const collected = await collectSubReferences({ root, workId: 'screens', decomposition: result.data });
    if (collected.warnings.length) warnings.push(...collected.warnings);
    state.screensFiles = collected.files;

    notify({ type: 'decompose.done', screens: state.screens.length, files: collected.files.length });
}