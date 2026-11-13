/**
 * @file src/cli/renderer.js
 * @purpose Terminal renderer for pipeline events.
 * @exports createRenderer, detectMode
 * @ai.hint keep
 */
import { COLORS, paint } from './colors.js';

/**
 * Detect terminal output mode.
 * @returns {'tty'|'pipe'|'quiet'}
 */
export function detectMode() {
    if (!process.stdout.isTTY) return 'pipe';
    return 'tty';
}

/**
 * Create a renderer for pipeline events.
 * @param {{ verbose?: boolean }} opts
 * @returns {{ event: (e: object) => void }}
 */
export function createRenderer({ verbose = false } = {}) {
    let stageLabel = '';

    function event(e) {
        if (!e || !e.type) return;
        switch (e.type) {
            case 'stage.start':
                stageLabel = e.label ?? e.stage;
                console.log(paint(`▶ ${stageLabel}`, COLORS.cyan));
                break;
            case 'stage.done':
                console.log(paint(`  ✓ ${e.stage}`, COLORS.green));
                break;
            case 'stage.error':
                console.error(paint(`  ✗ ${e.stage}: ${e.error}`, COLORS.red));
                break;
            case 'extend.done':
                if (verbose) console.log(`  extended: ${e.file} → ${e.to}`);
                break;
            case 'decompose.done':
                console.log(paint(`  screens: ${e.screens}, files: ${e.files}`, COLORS.dim));
                break;
            case 'rectify.done':
                console.log(paint(`  rectified: ${e.count}`, COLORS.dim));
                break;
            case 'reconstruct.file':
                if (verbose) console.log(`  restored: ${e.file}`);
                break;
            case 'overlap.done':
                console.log(paint(`  overlap resolved: ${e.count}`, COLORS.dim));
                break;
            case 'resolve.done':
                console.log(paint(`  output: ${e.path}`, COLORS.bold));
                break;
            case 'warning':
                console.warn(paint(`  ⚠ ${e.message}`, COLORS.yellow));
                break;
            default:
                if (verbose) console.log(`  [${e.type}]`, JSON.stringify(e));
        }
    }

    return { event };
}