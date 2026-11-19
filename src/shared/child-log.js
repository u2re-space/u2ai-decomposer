/**
 * @file src/shared/child-log.js
 * @module shared/child-log
 * @purpose The live log of a child process: the lines of a sibling CLI while it runs.
 *
 *   A child that writes into a pipe is quiet until it is over. The reader waits, and the
 *   silence says nothing: the child may work, may think, may hang. The reader of these
 *   lines shows every line of the child as it comes, so the wait becomes a log.
 *
 *   A chunk of a pipe has nothing to do with a line: it may carry three lines, or half of
 *   one. The reader keeps the tail that has no line break yet, and gives the lines that
 *   are ready.
 *
 *   The rules live here and only here, and the file is the same in every package of the
 *   house: when it changes, it changes everywhere.
 *
 * @depends nothing
 * @usedBy agent, stages, cli
 * @exports BRIDGE_LOG_LIMIT, createLineReader, splitLines, formatBridgeLine
 * @ai.tags house, log, bridges
 * @ai.hint io
 */

/** The longest line of the log of a child that is shown. */
export const BRIDGE_LOG_LIMIT = 400;

/**
 * The reader of the lines of a stream.
 *
 * The tail of a chunk that has no line break yet is kept until the rest of the line
 * comes. A line that is empty carries nothing and is dropped.
 * @param {(line: string) => void} onLine what to do with a line
 * @returns {{ push: (chunk: string|Buffer) => void, flush: () => void }}
 * @exports
 * @ai.hint pure
 */
export function createLineReader(onLine) {
    let rest = '';
    /**
     * Give one line to the reader of the log.
     * @param {string} line
     * @returns {void}
     */
    const give = (line) => {
        const text = String(line ?? '').replace(/\r$/, '');
        if (!text.trim()) return;
        onLine(text);
    };
    return {
        /**
         * Take a chunk of the stream and give the lines that are ready.
         * @param {string|Buffer} chunk
         * @returns {void}
         */
        push(chunk) {
            rest += String(chunk ?? '');
            const parts = rest.split(/\r?\n/);
            rest = parts.pop() ?? '';
            for (const part of parts) give(part);
        },
        /**
         * Give the tail of the stream: the child is over and the line will never be
         * finished.
         * @returns {void}
         */
        flush() {
            const tail = rest;
            rest = '';
            if (tail) give(tail);
        },
    };
}

/**
 * The lines of a text: the log of a child that is already over.
 * @param {string} text
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function splitLines(text) {
    return String(text ?? '')
        .split(/\r?\n/)
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.trim());
}

/**
 * The line of the log of a child, with the name of the child in front of it.
 *
 * A long line is cut: the log of a child is a sign of life, not a text to read.
 * @param {string} name the name of the child
 * @param {string} line the line of the child
 * @returns {string} the line, or an empty string when there is nothing to show
 * @exports
 * @ai.hint pure
 */
export function formatBridgeLine(name, line) {
    const text = String(line ?? '').trim();
    if (!text) return '';
    const who = String(name ?? '').trim() || 'child';
    const body = text.length > BRIDGE_LOG_LIMIT ? `${text.slice(0, BRIDGE_LOG_LIMIT)}…` : text;
    return `[${who}] ${body}`;
}
