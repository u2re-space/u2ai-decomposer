/**
 * @file src/agent/decomposition.js
 * @module agent/decomposition
 * @purpose Collect sub-references produced by the decomposer, hand to measurer, render report.
 * @depends node:path, node:fs/promises
 * @exports SUB_REFERENCE_DIR, MAX_SUB_REFERENCES, collectSubReferences, attachSubReferences, decompositionReport
 * @ai.tags decomposition, images, measurement
 * @ai.hint keep
 */
import path from 'node:path';
import { stat } from 'node:fs/promises';

export const SUB_REFERENCE_DIR = 'decomposition';
export const MAX_SUB_REFERENCES = 16;

/**
 * Locate one sub-reference path on disk.
 * @param {string} root project root
 * @param {string} rel cleaned path from decomposition
 * @param {string} workId working directory id
 * @returns {Promise<{ located: { abs: string, rel: string } | null, escapedRoot: boolean }>}
 */
export async function locateSubReference(root, rel, workId) {
    const prefix = `.tmp/${workId}/${SUB_REFERENCE_DIR}/`;
    const candidates = [rel];
    if (!rel.startsWith(`.tmp/${workId}/`)) candidates.push(`.tmp/${workId}/${rel}`);
    if (!rel.startsWith(prefix)) candidates.push(prefix + rel.split('/').pop());

    let escapedRoot = false;
    const seen = new Set();
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const abs = path.resolve(root, candidate);
        const info = await stat(abs).catch(() => null);
        if (info?.isFile()) return { located: { abs, rel: candidate }, escapedRoot: false };
    }
    return { located: null, escapedRoot };
}

/**
 * Read sub-references from decomposition and keep images that exist.
 * @param {{ root: string, workId: string, decomposition: object, maxBytes?: number, maxFiles?: number }} opts
 * @returns {Promise<{ files: Array<{ rel: string, abs: string, bytes: number, screen: string, kind: string, source: string, note: string }>, warnings: string[] }>}
 */
export async function collectSubReferences({ root, workId, decomposition, maxBytes = null, maxFiles = MAX_SUB_REFERENCES }) {
    const files = [];
    const warnings = [];
    const seen = new Set();
    const wanted = [];

    const listed = Array.isArray(decomposition?.subReferences) ? decomposition.subReferences : [];
    for (const entry of listed) {
        const rel = cleanPath(entry?.path);
        if (!rel) continue;
        wanted.push({ rel, screen: String(entry?.screen ?? '').trim(), kind: kindOf(entry?.kind), source: String(entry?.source ?? '').trim(), note: String(entry?.note ?? '').trim() });
    }

    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];
    for (const screen of screens) {
        const rel = cleanPath(screen?.subReference);
        if (!rel) continue;
        if (wanted.some((e) => e.rel === rel)) continue;
        wanted.push({ rel, screen: String(screen?.name ?? '').trim(), kind: kindOf(screen?.subReferenceKind), source: '', note: '' });
    }

    for (const entry of wanted) {
        if (files.length >= maxFiles) {
            warnings.push(`Sub-references more than ${maxFiles}: remaining skipped.`);
            break;
        }
        if (seen.has(entry.rel)) continue;
        seen.add(entry.rel);
        const { located } = await locateSubReference(root, entry.rel, workId);
        if (!located) {
            warnings.push(`Sub-reference not found: ${entry.rel}`);
            continue;
        }
        const info = await stat(located.abs).catch(() => null);
        if (!info?.isFile()) {
            warnings.push(`Sub-reference not found: ${entry.rel}`);
            continue;
        }
        if (maxBytes && info.size > maxBytes) {
            warnings.push(`Sub-reference ${entry.rel} exceeds limit (${info.size} bytes)`);
            continue;
        }
        files.push({ ...entry, rel: located.rel, abs: located.abs, bytes: info.size });
    }

    return { files, warnings };
}

/**
 * Attach collected sub-references for downstream roles.
 * @param {{ root: string, files: object[], maxBytes?: number }} opts
 * @returns {Promise<{ parts: object[], warnings: string[] }>}
 */
export async function attachSubReferences({ root, files, maxBytes = null }) {
    const parts = [];
    const warnings = [];
    for (const file of files) {
        try {
            const abs = file.abs;
            const { readFile } = await import('node:fs/promises');
            const bytes = await readFile(abs);
            parts.push({ type: 'input_image', source: { type: 'image', data: bytes.toString('base64'), media_type: 'image/png' } });
        } catch (error) {
            warnings.push(`Sub-reference ${file.rel} not attached: ${error.message}`);
        }
    }
    return { parts, warnings };
}

/**
 * Shared-context section for one decomposition.
 * @param {object} decomposition
 * @param {object[]} files collected sub-references
 * @param {string} dir project-relative work directory
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
        `Sub-references produced (${files.length}): ${files.map((f) => `${f.rel} [${f.kind}]`).join(', ')}`,
        `Decomposition JSON: ${dir}/decomposition.json; images: ${dir}/${SUB_REFERENCE_DIR}/.`,
    ].filter(Boolean).join('\n\n');
}

/** @returns {string|null} */
function cleanPath(value) {
    const text = String(value ?? '').trim().replace(/[\\/]/g, '/').replace(/^\.\//, '');
    if (!text || /^https?:\/\//i.test(text) || /^data:/i.test(text)) return null;
    return text;
}

/** @returns {string} */
function kindOf(value) {
    return SUB_REFERENCE_KINDS.includes(value) ? value : 'crop';
}