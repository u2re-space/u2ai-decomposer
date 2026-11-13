/**
 * @file src/cli/compatibility.js
 * @purpose Node.js version and feature detection.
 * @exports checkNodeVersion
 * @ai.hint keep
 */

/**
 * Verify that the current Node.js version meets requirements.
 * @returns {{ ok: boolean, version: string, required: string }}
 */
export function checkNodeVersion() {
    const version = process.versions.node;
    const major = parseInt(version, 10);
    const required = 26;
    return { ok: major >= required, version, required: `>=${required}` };
}