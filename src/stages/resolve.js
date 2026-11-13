/**
 * @file src/stages/resolve.js
 * @purpose Stage: assemble final resolved decomposition.json + layers (advanced).
 * @exports runResolve
 * @ai.hint keep
 */
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { ROLE_INSTRUCTIONS } from '../roles/index.js';
import { decompositionReport } from '../agent/decomposition.js';

/**
 * Run the resolve stage.
 * @param {object} state
 * @param {Function} notify
 */
export async function runResolve(state, notify = () => {}) {
    const { root, workDir, config, roles, model, effort, images, decomposition, screens, advanced, warnings } = state;

    // Build the resolved decomposition from all stage outputs.
    const resolved = {
        summary: decomposition?.summary ?? 'Decomposition resolved from pipeline stages',
        screens: (screens ?? []).map((screen, i) => ({
            ...screen,
            // Resolve to the final path after all stages.
            subReference: resolveFinalPath(screen.subReference, state),
            subReferenceKind: resolveFinalKind(screen.subReferenceKind, state),
        })),
        subReferences: (decomposition?.subReferences ?? []).map((ref) => ({
            ...ref,
            path: resolveFinalPath(ref.path, state),
        })),
        notes: decomposition?.notes ?? [],
        layers: [],
    };

    // Advanced: layer split.
    if (advanced && config.agent?.decomposerMode === 'advanced') {
        const layerTarget = resolved.screens[0]?.subReference;
        if (layerTarget) {
            try {
                const layerResult = await roles.run('director', {
                    text: `Perform layer split on ${layerTarget}. Write layers to ${workDir}/layers/.`,
                    instructions: ROLE_INSTRUCTIONS.director,
                    maxTurns: 12, model, effort,
                });
                if (layerResult.data?.layers) {
                    resolved.layers = layerResult.data.layers;
                    notify({ type: 'resolve.layers', count: resolved.layers.length });
                }
            } catch (e) {
                warnings.push(`resolve: layer split failed: ${e.message}`);
            }
        }
    }

    // Write decomposition.json.
    const jsonPath = path.join(root, workDir, 'decomposition.json');
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(resolved, null, 2));
    state.decomposition = resolved;
    state.outputPath = jsonPath;

    notify({ type: 'resolve.done', path: jsonPath, screens: resolved.screens.length, layers: resolved.layers.length });
}

/**
 * Resolve a sub-reference path through the stage pipeline to its final location.
 */
function resolveFinalPath(originalPath, state) {
    if (!originalPath) return null;
    // Check overlap stage.
    const overlapHit = state.overlapResolved?.find((r) => r.from === originalPath);
    if (overlapHit?.to && overlapHit.to !== overlapHit.from) return overlapHit.to;
    // Check reconstruct stage.
    const restoredHit = state.restored?.find((r) => r.from === originalPath);
    if (restoredHit?.to && restoredHit.to !== restoredHit.from) return restoredHit.to;
    // Check rectify stage.
    const rectifiedHit = state.rectified?.find((r) => r.from === originalPath);
    if (rectifiedHit?.to) return rectifiedHit.to;
    return originalPath;
}

function resolveFinalKind(kind, state) {
    return kind ?? 'crop';
}