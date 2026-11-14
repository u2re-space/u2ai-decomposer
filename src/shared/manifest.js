/**
 * @file src/shared/manifest.js
 * @module shared/manifest
 * @purpose The manifest of the work directory: what every stage produced.
 *
 *   The stages pass their artifacts to each other through the state of the run, and the state
 *   lives as long as the run does. The manifest is what stays on the disk: the name of every
 *   screen, the file it ended up in, and what replaced what. A run that starts in the middle of
 *   the pipeline reads it and continues as if the stages before it had just run.
 *
 * @depends node:path, node:fs/promises, agent/paths
 * @usedBy shared/pipeline, shared/resume
 * @exports MANIFEST_FILE, readManifest, writeManifest, saveStageManifest
 * @ai.tags manifest, artifacts
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { toPosix } from '../agent/paths.js';
import { screenNameOf } from './names.js';

/** The name of the manifest inside the work directory. */
export const MANIFEST_FILE = 'manifest.json';

/**
 * The files a stage produced, in the shape the manifest keeps.
 * @param {object} state pipeline state
 * @param {string} stageId the id of the stage
 * @returns {Array<{ rel: string, screen: string, kind: string, source: string, from: string }>}
 * @ai.hint pure
 */
export function filesOfStage(state, stageId) {
    const out = [];
    if (stageId === 'decompose' || stageId === 'rectify') {
        for (const file of state?.screensFiles ?? []) {
            if (!file?.rel) continue;
            out.push({
                rel: toPosix(file.rel),
                screen: String(file.screen ?? '').trim() || screenNameOf(file.rel),
                kind: String(file.kind ?? 'crop'),
                source: toPosix(file.source ?? ''),
                from: '',
            });
        }
        return out;
    }
    const list = stageId === 'reconstruct' ? state?.restored : state?.overlapResolved;
    for (const entry of list ?? []) {
        const from = toPosix(entry?.from ?? '');
        const to = toPosix(entry?.to ?? '');
        if (!from && !to) continue;
        out.push({
            rel: to || from,
            screen: String(entry?.screen ?? '').trim() || screenNameOf(from || to),
            kind: to ? 'repaired' : 'crop',
            source: '',
            from,
        });
    }
    return out;
}

/**
 * The chain of the files: what replaced what.
 * @param {object} state pipeline state
 * @returns {Array<{ from: string, to: string, kind: string, stage: string, screen: string }>}
 * @ai.hint pure
 */
export function chainOfState(state) {
    const chain = [];
    const stages = [
        { stage: 'rectify', list: state?.rectified },
        { stage: 'reconstruct', list: state?.restored },
        { stage: 'overlap', list: state?.overlapResolved },
    ];
    for (const { stage, list } of stages) {
        for (const entry of list ?? []) {
            const from = toPosix(entry?.from ?? '');
            const to = toPosix(entry?.to ?? '');
            if (!from || !to || from === to) continue;
            chain.push({
                from,
                to,
                kind: stage === 'rectify' ? 'restored' : 'repaired',
                stage,
                screen: String(entry?.screen ?? '').trim() || screenNameOf(from),
            });
        }
    }
    return chain;
}

/**
 * Read the manifest of a work directory.
 * @param {string} workDir the work directory
 * @returns {Promise<object>} the manifest, or an empty one when there is none
 * @ai.hint io
 */
export async function readManifest(workDir) {
    try {
        const raw = await readFile(path.join(workDir, MANIFEST_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Write the manifest of a work directory.
 * @param {string} workDir the work directory
 * @param {object} manifest the manifest
 * @returns {Promise<void>}
 * @ai.hint io
 */
export async function writeManifest(workDir, manifest) {
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(workDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Remember what a stage produced, and keep what the stages before it produced.
 * @param {object} state pipeline state
 * @param {string} stageId the id of the stage that has just run
 * @returns {Promise<object>} the manifest that was written
 * @ai.hint io
 */
export async function saveStageManifest(state, stageId) {
    const workDir = state?.workDir;
    if (!workDir) return {};
    const manifest = await readManifest(workDir);
    const stages = { ...(manifest.stages ?? {}) };
    stages[stageId] = { files: filesOfStage(state, stageId) };
    const next = {
        ...manifest,
        stages,
        chain: chainOfState(state),
        screens: (state?.screens ?? []).map((screen) => ({
            name: String(screen?.name ?? '').trim(),
            source: toPosix(screen?.source ?? ''),
            subReference: toPosix(screen?.subReference ?? ''),
            subReferenceKind: String(screen?.subReferenceKind ?? 'crop'),
        })),
    };
    await writeManifest(workDir, next);
    return next;
}
