/**
 * @file src/cli/colors.js
 * @purpose ANSI color constants and paint helper.
 * @exports COLORS, paint
 * @ai.hint keep
 */
export const COLORS = Object.freeze({
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
});

/**
 * Wrap text in ANSI color codes.
 * @param {string} text
 * @param {string} color
 * @returns {string}
 */
export function paint(text, color) {
    if (!process.stdout.isTTY) return text;
    return `${color}${text}${COLORS.reset}`;
}