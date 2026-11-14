/**
 * @file src/openai/journal.js
 * @module openai/journal
 * @purpose The journal of the answers: a directory on disk where every request and every answer
 *          is kept under the hash of the request. The hash is the name of the request — the same
 *          question always has the same name, in this run and in the next one.
 *
 *   Why the journal exists. The batch route of the hosts is two-phase: the requests go out, the
 *   answers come back later. Between the two phases the pipeline has to run again — and the
 *   second run must not pay for the same answer twice. The journal is what makes that possible:
 *   the answer is looked up by the hash of the request, not by the order of the calls.
 *
 *   The journal keeps the bytes of the picture edits too. An edit is not a part of a batch, but
 *   it sits between two phases of the run, and an edit that is paid for twice is an edit that
 *   costs twice.
 *
 * @depends node:crypto, node:path, node:fs/promises
 * @usedBy openai/client
 * @exports createJournal, hashValue, hashBytes, stableStringify
 * @ai.tags openai, batch, journal
 * @ai.hint io
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

/**
 * JSON with the keys in a fixed order.
 *
 * The hash of a request must not depend on the order the keys were written in: the same
 * question is built by the same code, but the order of the keys of a body is not a promise.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
export function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * The name of a request: the hash of its body.
 * @param {unknown} value
 * @returns {string} 64 hex characters
 * @ai.hint pure
 */
export function hashValue(value) {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * The name of a request that carries a picture: the hash of the bytes.
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 * @ai.hint pure
 */
export function hashBytes(bytes) {
    return createHash('sha256').update(Buffer.from(bytes ?? [])).digest('hex');
}

/**
 * Create the journal.
 *
 * The layout of the directory:
 * - `requests/<hash>.json` — what was asked (the name, the model, the time);
 * - `answers/<hash>.json` — the answer (JSON, or the name of the file with the bytes);
 * - `answers/<hash>.bin` — the bytes of a picture edit;
 * - `batches/<id>.json` — the batches that were submitted and what they carry.
 * @param {{ dir: string }} options the directory of the journal
 * @returns {{ dir: string, init: Function, hash: Function, hashBytes: Function, read: Function,
 *   writeJson: Function, writeBytes: Function, writeError: Function, rememberRequest: Function,
 *   saveBatch: Function, listBatches: Function, updateBatch: Function }}
 * @ai.hint io
 */
export function createJournal({ dir } = {}) {
    const root = path.resolve(String(dir ?? '.batch'));
    const requestsDir = path.join(root, 'requests');
    const answersDir = path.join(root, 'answers');
    const batchesDir = path.join(root, 'batches');

    /**
     * Make sure the directories of the journal are there.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function init() {
        await mkdir(requestsDir, { recursive: true });
        await mkdir(answersDir, { recursive: true });
        await mkdir(batchesDir, { recursive: true });
    }

    /**
     * Read the answer of a request.
     * @param {string|null} hash the name of the request
     * @returns {Promise<{kind: 'json'|'bytes'|'error', value: any}|null>} null when there is no answer
     * @ai.hint io
     */
    async function read(hash) {
        if (!hash) return null;
        const raw = await readFile(path.join(answersDir, `${hash}.json`), 'utf8').catch(() => null);
        if (raw === null) return null;
        let row = null;
        try { row = JSON.parse(raw); } catch { return null; }
        if (row?.kind === 'bytes') {
            const bytes = await readFile(path.join(answersDir, String(row.file ?? ''))).catch(() => null);
            return bytes ? { kind: 'bytes', value: bytes } : null;
        }
        if (row?.kind === 'error') return { kind: 'error', value: String(row.message ?? 'the request failed') };
        return { kind: 'json', value: row?.value ?? null };
    }

    /**
     * Write the answer of a request.
     * @param {string} hash the name of the request
     * @param {unknown} value the answer
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function writeJson(hash, value) {
        if (!hash) return;
        await init();
        await writeFile(
            path.join(answersDir, `${hash}.json`),
            `${JSON.stringify({ kind: 'json', hash, value })}\n`,
        );
    }

    /**
     * Write the bytes of an answer — the picture of an edit.
     * @param {string} hash the name of the request
     * @param {Buffer} bytes the answer
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function writeBytes(hash, bytes) {
        if (!hash) return;
        await init();
        const file = `${hash}.bin`;
        await writeFile(path.join(answersDir, file), bytes);
        await writeFile(
            path.join(answersDir, `${hash}.json`),
            `${JSON.stringify({ kind: 'bytes', hash, file })}\n`,
        );
    }

    /**
     * Write the failure of a request.
     *
     * A failure is remembered too: a request that failed in a batch must not be sent again and
     * again, once per phase, forever.
     * @param {string} hash the name of the request
     * @param {string} message what went wrong
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function writeError(hash, message) {
        if (!hash) return;
        await init();
        await writeFile(
            path.join(answersDir, `${hash}.json`),
            `${JSON.stringify({ kind: 'error', hash, message: String(message ?? 'the request failed') })}\n`,
        );
    }

    /**
     * Remember that a request was asked.
     * @param {string} hash the name of the request
     * @param {{ customId?: string|null, model?: string|null }} [meta]
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function rememberRequest(hash, { customId = null, model = null } = {}) {
        if (!hash) return;
        await init();
        await writeFile(
            path.join(requestsDir, `${hash}.json`),
            `${JSON.stringify({ hash, customId, model, createdAt: new Date().toISOString() })}\n`,
        );
    }

    /**
     * Remember a submitted batch: the host it belongs to and the requests it carries.
     * @param {{ id: string, host: string, endpoint: string, requests: Array<object>, status?: string }} batch
     * @returns {Promise<object>} the row that was written
     * @ai.hint io
     */
    async function saveBatch({ id, host, endpoint, requests = [], status = 'submitted' } = {}) {
        await init();
        const row = {
            id: String(id),
            host: String(host ?? ''),
            endpoint: String(endpoint ?? ''),
            status: String(status),
            requests,
            done: false,
            createdAt: new Date().toISOString(),
        };
        await writeFile(path.join(batchesDir, `${row.id}.json`), `${JSON.stringify(row, null, 2)}\n`);
        return row;
    }

    /**
     * Every batch the journal knows about.
     * @returns {Promise<Array<object>>}
     * @ai.hint io
     */
    async function listBatches() {
        await init();
        const names = await readdir(batchesDir).catch(() => []);
        const out = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const raw = await readFile(path.join(batchesDir, name), 'utf8').catch(() => null);
            if (!raw) continue;
            try { out.push(JSON.parse(raw)); } catch { /* a broken file is not a batch */ }
        }
        return out;
    }

    /**
     * Change the row of a batch.
     * @param {string} id the name of the batch
     * @param {object} patch the fields to change
     * @returns {Promise<object|null>} the row that was written
     * @ai.hint io
     */
    async function updateBatch(id, patch = {}) {
        const rows = await listBatches();
        const row = rows.find((item) => item.id === String(id));
        if (!row) return null;
        const next = { ...row, ...patch };
        await writeFile(path.join(batchesDir, `${next.id}.json`), `${JSON.stringify(next, null, 2)}\n`);
        return next;
    }

    return {
        dir: root,
        init,
        hash: hashValue,
        hashBytes,
        read,
        writeJson,
        writeBytes,
        writeError,
        rememberRequest,
        saveBatch,
        listBatches,
        updateBatch,
    };
}
