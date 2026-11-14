/**
 * @file src/shared/resume.js
 * @module shared/resume
 * @purpose Continue a run from the artifacts of the last one.
 *
 *   A stage may be run on its own: the restorer on the screens of the last run, the overlap on
 *   the restored screens, the resolve on everything that is already on the disk. The stages
 *   before it are not repeated — they cost money, and their answer is already written down.
 *
 *   The artifacts are read from the manifest of the work directory: it knows the name of every
 *   screen and the file it ended up in. When the manifest says nothing, the pictures of the
 *   directories are read instead, the name of a screen is taken from the name of its file, and
 *   only the files of the last run are taken: a directory keeps the files of the runs before it.
 *
 * @depends node:path, node:fs/promises, agent/paths, stages/index, shared/manifest, shared/names
 * @usedBy shared/pipeline
 * @exports resumeFromWorkDir, latestBatch
 * @ai.tags resume, stages
 * @ai.hint io
 */

import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { toPosix } from '../agent/paths.js';
import { STAGE_DIRS } from '../stages/index.js';
import { readManifest } from './manifest.js';
import { screenNameOf } from './names.js';

/**
 * The gap between two runs: the files of one run are written one after another, and a longer
 * pause between two files means that the older one belongs to an earlier run.
 */
const RUN_GAP_MS = 10 * 60 * 1000;

/**
 * The pictures of one directory of the work directory.
 * @param {string} dir the absolute path of the directory
 * @returns {Promise<Array<{ name: string, abs: string, bytes: number, mtime: number }>>}
 * @ai.hint io
 */
async function picturesIn(dir) {
    let names = [];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const name of names.sort()) {
        if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
        const abs = path.join(dir, name);
        const info = await stat(abs).catch(() => null);
        if (!info?.isFile()) continue;
        out.push({ name, abs, bytes: info.size, mtime: info.mtimeMs });
    }
    return out;
}

/**
 * The newest batch of files: the files of the last run.
 *
 * A directory of the work directory keeps the files of every run that wrote to it, so a run
 * that starts without a manifest sees the screens of the runs before it as well. The files of
 * one run are written one after another, and a pause between two files means that the older one
 * belongs to an earlier run: the last run is the newest batch of files.
 * @param {Array<{ mtime?: number }>} files the files of a directory, with their times
 * @returns {Array<object>} the files of the last run, in the order of their names
 * @exports
 * @ai.hint pure
 */
export function latestBatch(files) {
    if (files.length <= 1) return files;
    const sorted = [...files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const newest = sorted[0].mtime ?? 0;
    const batch = [sorted[0]];
    for (const file of sorted.slice(1)) {
        if (newest - (file.mtime ?? 0) > RUN_GAP_MS) break;
        batch.push(file);
    }
    return batch.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/**
 * The reference the screens were cut from: the extended one when it is there.
 * @param {string} root project root
 * @param {string[]} references the pictures the run started from
 * @returns {Promise<string>}
 * @ai.hint io
 */
async function sourceOf(root, references) {
    for (const rel of references) {
        if (!/extended/i.test(rel)) continue;
        const info = await stat(path.resolve(root, rel)).catch(() => null);
        if (info?.isFile()) return rel;
    }
    return references[0] ?? '';
}

/**
 * The files of a stage, from the manifest of the last run.
 * @param {object} manifest the manifest
 * @param {string} stageId the id of the stage
 * @returns {Array<object>}
 * @ai.hint pure
 */
function filesFromManifest(manifest, stageId) {
    const files = manifest?.stages?.[stageId]?.files;
    return Array.isArray(files) ? files : [];
}

/**
 * Fill the state with the artifacts of the last run.
 *
 * The state of a fresh run is empty: the stages fill it as they go. When the run starts in the
 * middle of the pipeline, the state is filled from the work directory instead, and the stage
 * that follows works on exactly the files the last run left.
 * @param {object} state pipeline state
 * @param {{ stages?: string[], notify?: Function|null }} [options]
 * @returns {Promise<{ resumed: boolean, dir: string|null, files: number }>}
 * @usedBy shared/pipeline
 * @ai.hint io
 */
export async function resumeFromWorkDir(state, { stages = [], notify = null } = {}) {
    const root = state?.root ?? '.';
    const workDir = state?.workDir ?? path.join(root, 'decomposition');
    const toRun = Array.isArray(stages) ? stages : [];

    // The decompose stage is the one that cuts the screens: when it runs, there is nothing to
    // continue from.
    if (toRun.includes('decompose')) return { resumed: false, dir: null, files: 0 };

    // The stage that runs first wants the earliest artifacts, and the stage that runs last wants
    // the latest ones.
    const wanted = toRun.includes('rectify')
        ? ['decompose']
        : (toRun.includes('overlap')
            ? ['reconstruct', 'rectify', 'decompose']
            : ['rectify', 'reconstruct', 'decompose']);

    const manifest = await readManifest(workDir);
    const references = Array.isArray(state.references) && state.references.length
        ? state.references
        : (Array.isArray(state.images) ? state.images : []);
    const source = await sourceOf(root, references);

    let stageId = null;
    let files = [];
    for (const wantedStage of wanted) {
        const fromManifest = [];
        for (const file of filesFromManifest(manifest, wantedStage)) {
            if (!file?.rel) continue;
            const abs = path.resolve(root, file.rel);
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) continue;
            fromManifest.push({ ...file, abs });
        }
        if (fromManifest.length) {
            stageId = wantedStage;
            files = fromManifest;
            break;
        }
        const dir = path.join(workDir, STAGE_DIRS[wantedStage]);
        const found = latestBatch(await picturesIn(dir));
        if (found.length) {
            stageId = wantedStage;
            files = found.map((file) => ({
                rel: toPosix(path.join(path.relative(root, dir), file.name)),
                abs: file.abs,
                bytes: file.bytes,
                screen: screenNameOf(file.name),
                kind: 'crop',
                source,
                from: '',
            }));
            break;
        }
    }
    if (!stageId || !files.length) {
        // The run cuts the screens itself: there is nothing to continue from, and nothing to say.
        const cuts = toRun.includes('decompose') || toRun.includes('rectify');
        if (!cuts) notify?.({ type: 'resume.empty' });
        return { resumed: false, dir: null, files: 0 };
    }

    const screensFiles = files.map((file) => ({
        rel: toPosix(file.rel),
        abs: file.abs ?? path.resolve(root, file.rel),
        bytes: file.bytes ?? 0,
        screen: String(file.screen ?? '').trim() || screenNameOf(file.rel),
        kind: String(file.kind ?? 'crop'),
        source: file.source || source,
        note: '',
    }));

    // The names of the screens of the last run are in the answer of the decompose stage.
    let decomposition = state.decomposition ?? null;
    if (!decomposition) {
        try {
            decomposition = JSON.parse(await readFile(path.join(workDir, 'decompose.json'), 'utf8'));
        } catch {
            decomposition = null;
        }
    }

    const screens = screensFiles.map((file) => ({
        name: file.screen,
        source: file.source,
        subReference: file.rel,
        subReferenceKind: file.kind || 'crop',
    }));

    state.screens = screens;
    state.screensFiles = screensFiles;
    state.images = screensFiles.map((file) => file.rel);
    if (decomposition) state.decomposition = decomposition;

    const dir = toPosix(path.dirname(screensFiles[0].rel));
    notify?.({ type: 'resume', dir, files: screensFiles.length, stage: stageId });
    return { resumed: true, dir, files: screensFiles.length };
}
