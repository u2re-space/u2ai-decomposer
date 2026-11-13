/**
 * @file src/image/magick.js
 * @purpose ImageMagick detection and wrapper operations.
 * @exports detectMagick, magickCrop, magickIdentify
 * @ai.hint keep
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Detect ImageMagick binary path.
 * @param {string|null} [configPath]
 * @returns {Promise<string|null>}
 */
export async function detectMagick(configPath = null) {
    if (configPath) return configPath;
    for (const cmd of ['magick', 'convert']) {
        try { await exec(cmd, ['-version']); return cmd; } catch {}
    }
    return null;
}

/**
 * Crop via ImageMagick.
 */
export async function magickCrop(input, output, { x, y, width, height }) {
    await exec('magick', [input, '-crop', `${width}x${height}+${x}+${y}`, '+repage', output]);
}

/**
 * Identify image via ImageMagick.
 */
export async function magickIdentify(input) {
    const { stdout } = await exec('magick', ['identify', '-format', '%w %h %m', input]);
    const [w, h, m] = stdout.trim().split(/\s+/);
    return { width: parseInt(w), height: parseInt(h), format: m };
}