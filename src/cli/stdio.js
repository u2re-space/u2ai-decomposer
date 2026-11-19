/**
 * @file src/cli/stdio.js
 * @module cli/stdio
 * @purpose The two streams of the CLI: what goes out and what goes into the log.
 *
 *   Everything the CLI prints goes through this module, so the streams can be replaced
 *   in the tests and the text of the model can be cleaned before it is written: a
 *   control character in an answer must not move the cursor of the terminal.
 *
 * @depends none
 * @usedBy cli, cli/renderer, cli/component, cli/install
 * @exports sanitizeText, createStdio
 * @ai.tags cli, stdio
 * @ai.hint keep
 * @changed 2026-11-13 First version: the writers of the CLI.
 */

/** The escape sequences of the terminal: CSI, OSC and the short ones. */
const ESCAPES = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** The control characters that are not a line break and not a tab. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Clean the text that comes from outside: the escape sequences and the control
 * characters go away, the line breaks and the tabs stay.
 *
 * @param {unknown} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function sanitizeText(text) {
    return String(text ?? '').replace(ESCAPES, '').replace(CONTROLS, '');
}

/**
 * Create the writers of the CLI.
 *
 * @param {{ stdout?: object, stderr?: object }} [options]
 * @returns {{ stdout: object, stderr: object, write: Function, line: Function,
 *   error: Function, json: Function }}
 * @exports
 * @ai.hint pure
 */
export function createStdio({ stdout = process.stdout, stderr = process.stderr } = {}) {
    return {
        stdout,
        stderr,

        /**
         * Write the text on stdout as it is.
         * @param {string} text
         * @returns {void}
         */
        write(text) {
            stdout.write(String(text ?? ''));
        },

        /**
         * Write one cleaned line on stdout.
         * @param {string} [text]
         * @returns {void}
         */
        line(text = '') {
            stdout.write(`${sanitizeText(text)}\n`);
        },

        /**
         * Write one cleaned line on stderr.
         * @param {string} [text]
         * @returns {void}
         */
        error(text = '') {
            stderr.write(`${sanitizeText(text)}\n`);
        },

        /**
         * Write one json object on stdout as a line.
         * @param {object} value
         * @returns {void}
         */
        json(value) {
            stdout.write(`${JSON.stringify(value)}\n`);
        },
    };
}
