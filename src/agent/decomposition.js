/**
 * @file src/agent/decomposition.js
 * @module agent/decomposition
 * @purpose Collect the sub-references the decomposer produced, attach them, render the report.
 * @depends node:path, node:fs/promises, agent/paths, openai/responses, openai/images
 * @exports SCREENS_DIR, MAX_SUB_REFERENCES, locateSubReference, collectSubReferences, attachSubReferences, decompositionReport
 * @ai.tags decomposition, images, measurement
 * @ai.hint keep
 */
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { imagePart } from '../openai/responses.js';
import { sniffImage } from '../openai/images.js';
import { DECOMPOSER_KINDS } from './schemas.js';
import { resolveInside, toPosix } from './paths.js';

/** The directory of the work dir that holds the screens. */
export const SCREENS_DIR = 'screens';

/** The default number of sub-references one decomposition may keep. */
export const MAX_SUB_REFERENCES = 16;

/**
 * Locate one sub-reference path on disk.
 *
 * The model may answer with the path it wrote, with a path relative to the screens directory or
 * with a bare file name; all three are tried. A path that leaves the working directory is refused.
 * @param {string} root project root
 * @param {string} rel path from the decomposition answer
 * @param {string} screensRel the screens directory, relative to the root
 * @returns {Promise<{ located: { abs: string, rel: string } | null, escapedRoot: boolean }>}
 */
export async function locateSubReference(root, rel, screensRel) {
    const candidates = [rel];
    if (!rel.startsWith(`${screensRel}/`)) candidates.push(`${screensRel}/${rel}`);
    candidates.push(`${screensRel}/${path.basename(rel)}`);

    let escapedRoot = false;
    const seen = new Set();
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        let located = null;
        try {
            located = await resolveInside(root, candidate, { allowRoot: false });
        } catch {
            escapedRoot = true;
            continue;
        }
        const info = await stat(located.abs).catch(() => null);
        if (info?.isFile()) return { located: { abs: located.abs, rel: located.rel }, escapedRoot };
    }
    return { located: null, escapedRoot };
}

/**
 * Read the sub-references of a decomposition and keep the files that exist.
 * @param {{ root: string, workDir: string, decomposition: object, maxBytes?: number|null,
 *   maxFiles?: number }} opts
 * @returns {Promise<{ files: Array<{ rel: string, abs: string, bytes: number, screen: string,
 *   kind: string, source: string, note: string }>, warnings: string[] }>}
 */
export async function collectSubReferences({ root, workDir, decomposition, maxBytes = null, maxFiles = MAX_SUB_REFERENCES }) {
    const files = [];
    const warnings = [];
    const seen = new Set();
    const wanted = [];
    const screensRel = toPosix(path.join(workDir, SCREENS_DIR));

    const listed = Array.isArray(decomposition?.subReferences) ? decomposition.subReferences : [];
    for (const entry of listed) {
        const rel = cleanPath(entry?.path);
        if (!rel) continue;
        wanted.push({
            rel,
            screen: String(entry?.screen ?? '').trim(),
            kind: kindOf(entry?.kind),
            source: String(entry?.source ?? '').trim(),
            note: String(entry?.note ?? '').trim(),
        });
    }

    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];
    for (const screen of screens) {
        const rel = cleanPath(screen?.subReference);
        if (!rel) continue;
        if (wanted.some((entry) => entry.rel === rel)) continue;
        wanted.push({
            rel,
            screen: String(screen?.name ?? '').trim(),
            kind: kindOf(screen?.subReferenceKind),
            source: String(screen?.source ?? '').trim(),
            note: '',
        });
    }

    for (const entry of wanted) {
        if (files.length >= maxFiles) {
            warnings.push(`Sub-references more than ${maxFiles}: remaining skipped.`);
            break;
        }
        if (seen.has(entry.rel)) continue;
        seen.add(entry.rel);
        const { located, escapedRoot } = await locateSubReference(root, entry.rel, screensRel);
        if (!located) {
            warnings.push(escapedRoot
                ? `Sub-reference is outside the working directory: ${entry.rel}`
                : `Sub-reference not found: ${entry.rel}`);
            continue;
        }
        const info = await stat(located.abs).catch(() => null);
        if (!info?.isFile()) {
            warnings.push(`Sub-reference not found: ${entry.rel}`);
            continue;
        }
        if (maxBytes && info.size > maxBytes) {
            warnings.push(`Sub-reference ${located.rel} exceeds limit (${info.size} bytes)`);
            continue;
        }
        files.push({ ...entry, rel: located.rel, abs: located.abs, bytes: info.size });
    }

    return { files, warnings };
}

/**
 * Attach collected sub-references for downstream roles.
 * @param {{ files: object[], maxBytes?: number|null }} opts
 * @returns {Promise<{ parts: object[], warnings: string[] }>}
 */
export async function attachSubReferences({ files, maxBytes = null } = {}) {
    const parts = [];
    const warnings = [];
    for (const file of files) {
        try {
            const bytes = await readFile(file.abs);
            if (maxBytes && bytes.length > maxBytes) {
                warnings.push(`Sub-reference ${file.rel} exceeds limit (${bytes.length} bytes)`);
                continue;
            }
            parts.push(imagePart(bytes, sniffImage(bytes).mime));
        } catch (error) {
            warnings.push(`Sub-reference ${file.rel} not attached: ${error.message}`);
        }
    }
    return { parts, warnings };
}

/**
 * The section of the shared context that describes one decomposition.
 * @param {object} decomposition
 * @param {object[]} files collected sub-references
 * @param {string} dir the work directory, relative to the root
 * @returns {string}
 */
export function decompositionReport(decomposition, files, dir) {
    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];
    const byPath = new Map(files.map((file) => [file.rel, file]));
    const lines = screens.map((screen, index) => {
        const bits = [`- ${index + 1}. ${screen.name || '(unnamed)'}`];
        if (screen.source) bits.push(`source ${screen.source}`);
        const sub = cleanPath(screen.subReference);
        const entry = sub ? byPath.get(sub) : null;
        bits.push(entry ? `sub-reference ${entry.rel} (${entry.kind})` : 'sub-reference (none)');
        if (screen.purpose) bits.push(screen.purpose);
        return bits.join(' · ');
    });
    return [
        `Decomposition: ${decomposition?.summary || '(no summary)'}`,
        lines.join('\n'),
        `Sub-references produced (${files.length}): ${files.map((file) => `${file.rel} [${file.kind}]`).join(', ')}`,
        `Decomposition JSON: ${dir}/decomposition.json; images: ${dir}/${SCREENS_DIR}/.`,
    ].filter(Boolean).join('\n\n');
}

/**
 * Normalize a path the model answered with.
 * @param {unknown} value
 * @returns {string|null}
 * @ai.hint pure
 */
function cleanPath(value) {
    const text = String(value ?? '').trim().replace(/[\\/]/g, '/').replace(/^\.\//, '');
    if (!text || /^https?:\/\//i.test(text) || /^data:/i.test(text)) return null;
    return text;
}

/**
 * Normalize a kind the model answered with.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function kindOf(value) {
    const text = String(value ?? '').trim();
    return DECOMPOSER_KINDS.includes(text) ? text : 'crop';
}
