/**
 * @file src/cli/protocol.js
 * @module cli/protocol
 * @purpose The wire contract between the ai-webdev worker and its graphical shell.
 *
 *   The worker keeps its classic stdout and stderr. The protocol is a separate,
 *   bidirectional channel: the shell receives the events of the run and sends the
 *   operator's input back. Every frame carries the protocol version, so an old shell
 *   can refuse a new worker instead of guessing.
 *
 * @depends none
 * @usedBy cli/worker, tui/worker-client
 * @exports PROTOCOL_VERSION, FRAME, createFrame, isFrame
 * @ai.tags cli, worker, protocol
 */

import { randomUUID } from 'node:crypto';

/** The version of the protocol between the worker and the shell. */
export const PROTOCOL_VERSION = 1;

/** The kinds of frame of the protocol. */
export const FRAME = Object.freeze({
    ready: 'ready',
    event: 'event',
    question: 'question',
    status: 'status',
    result: 'result',
    error: 'error',
    input: 'input',
    answer: 'answer',
    command: 'command',
});

/**
 * Create one frame of the protocol.
 * @param {string} type the kind of the frame
 * @param {object} [payload] the fields of the frame
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createFrame(type, payload = {}) {
    const kind = String(type ?? '').trim();
    if (!Object.hasOwn(FRAME, kind)) throw new Error(`Unknown protocol frame: ${kind || '(empty)'}.`);
    return { v: PROTOCOL_VERSION, type: kind, ...payload };
}

/**
 * Whether a value is a frame of this protocol version.
 * @param {unknown} value
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isFrame(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Number(value.v) === PROTOCOL_VERSION
        && typeof value.type === 'string'
        && Object.hasOwn(FRAME, value.type);
}

/**
 * Make the id of a question of the operator.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function questionId() {
    return `q-${randomUUID()}`;
}
