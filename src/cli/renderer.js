/**
 * @file src/cli/renderer.js
 * @purpose Terminal renderer for pipeline events.
 * @exports createRenderer, createPlainRenderer, detectMode
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
 * Print the dry-run plan in a form both renderers can use.
 * @param {object} event
 */
function printPlan(event) {
    console.log('Plan:');
    const images = Array.isArray(event.images) ? event.images : [];
    console.log(`  inputs: ${images.length ? images.join(', ') : '(none)'}`);
    for (const stage of event.stages ?? []) {
        const models = [stage.model, stage.imageModel].filter(Boolean).join(', ');
        console.log(`  ${stage.id}: ${stage.label}${models ? ` [${models}]` : ''}`);
    }
    for (const output of event.outputs ?? []) console.log(`  output: ${output}`);
}

/**
 * A renderer without colors, for a pipe.
 *
 * A run whose output is piped somewhere — a CI log, a file, another program — has to leave
 * something behind. The colored renderer is for a person at a terminal; this one is for the
 * reader on the other side of the pipe.
 *
 * @param {{ verbose?: boolean }} opts
 * @returns {{ event: (e: object) => void }}
 */
export function createPlainRenderer({ verbose = false } = {}) {
    function event(e) {
        if (!e || !e.type) return;
        switch (e.type) {
            case 'plan':
                printPlan(e);
                break;
            case 'stage.start':
                console.log(`[${e.stage}] ${e.label ?? e.stage}`);
                break;
            case 'stage.done':
                console.log(`[${e.stage}] done`);
                break;
            case 'stage.error':
                console.error(`[${e.stage}] failed: ${e.error}`);
                break;
            case 'extend.done':
                if (verbose) console.log(`  extended: ${e.file} → ${e.to}`);
                break;
            case 'decompose.done':
                console.log(`  screens: ${e.screens}, files: ${e.files}`);
                break;
            case 'decompose.report':
                if (verbose) console.log(e.report);
                break;
            case 'rectify.done':
                console.log(`  rectified: ${e.count}`);
                break;
            case 'rectify.file':
                if (verbose) console.log(`  rectified: ${e.file}`);
                break;
            case 'reconstruct.file':
                if (verbose) console.log(`  restored: ${e.file}`);
                break;
            case 'reconstruct.done':
                console.log(`  restored: ${e.file} (${e.status})`);
                break;
            case 'overlap.file':
                if (verbose) console.log(`  overlap cleaned: ${e.file}`);
                break;
            case 'overlap.done':
                console.log(`  overlap resolved: ${e.count}`);
                break;
            case 'resolve.done':
                console.log(`  output: ${e.path}`);
                break;
            case 'warning':
                console.warn(`  warning: ${e.message}`);
                break;
            default:
                if (verbose) console.log(`  [${e.type}]`, JSON.stringify(e));
        }
    }

    return { event };
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
            case 'plan':
                printPlan(e);
                break;
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
            case 'decompose.report':
                if (verbose) console.log(e.report);
                break;
            case 'rectify.done':
                console.log(paint(`  rectified: ${e.count}`, COLORS.dim));
                break;
            case 'rectify.file':
                if (verbose) console.log(paint(`  rectified: ${e.file}`, COLORS.dim));
                break;
            case 'reconstruct.file':
                if (verbose) console.log(`  restored: ${e.file}`);
                break;
            case 'reconstruct.done':
                console.log(paint(`  restored: ${e.file} (${e.status})`, COLORS.dim));
                break;
            case 'overlap.file':
                if (verbose) console.log(paint(`  overlap cleaned: ${e.file}`, COLORS.dim));
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