/**
 * @file src/cli/renderer.js
 * @module cli/renderer
 * @purpose Terminal renderer for pipeline events.
 *
 *   A stage of the pipeline may take minutes: a reasoning model reads a picture, a picture
 *   model paints a band. A terminal that says nothing during those minutes looks like a
 *   hung program, so the renderer keeps a live line under the stage header: what the run
 *   is doing right now and how long it has been doing it. The line is erased when the
 *   stage ends, and the stage leaves its duration behind.
 *
 *   The plain renderer is the same idea without the moving parts: it writes a line when
 *   the work changes, so a log of a piped run still shows the progress.
 *
 * @exports createRenderer, createPlainRenderer, detectMode, formatDuration, summaryLines
 * @ai.tags cli, renderer
 * @ai.hint keep
 */
import { COLORS, paint } from './colors.js';

/** The frames of the spinner. */
const SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);

/** How often the live line is redrawn, in milliseconds. */
const TICK_MS = 250;

/**
 * Detect terminal output mode.
 * @returns {'tty'|'pipe'|'quiet'}
 */
export function detectMode() {
    if (!process.stdout.isTTY) return 'pipe';
    return 'tty';
}

/**
 * A duration as a short human string: `12 s`, `1 m 12 s`, `1 h 04 m`.
 * @param {number} ms the milliseconds
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, '0')} m`;
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
 * The line of a role that is thinking.
 * @param {object} event
 * @returns {string}
 * @ai.hint pure
 */
function roleLine(event) {
    const role = String(event.role ?? 'the model');
    const model = event.model ? ` (${event.model})` : '';
    const turn = Number.isSafeInteger(event.turn) && Number.isSafeInteger(event.turns) && event.turns > 1
        ? `, turn ${event.turn}/${event.turns}`
        : '';
    return `the ${role} role is answering${model}${turn}`;
}

/**
 * The lines of the final summary of a run.
 *
 * The reader has to be able to answer three questions without opening a file: where the answer is,
 * what is in it, and what went wrong. The summary says all three.
 * @param {{ output?: object|null, outputPath?: string|null, warnings?: string[] }} result
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function summaryLines(result) {
    const lines = [];
    const output = result?.output ?? null;
    const path = result?.outputPath ?? null;
    if (path) lines.push(`output: ${path}`);
    const screens = Array.isArray(output?.screens) ? output.screens : [];
    const files = Array.isArray(output?.subReferences) ? output.subReferences : [];
    lines.push(`screens: ${screens.length}`);
    for (const screen of screens) {
        const name = String(screen?.name ?? '').trim() || '(unnamed)';
        const file = String(screen?.subReference ?? '').trim();
        lines.push(`  - ${name}${file ? ` → ${file}` : ' → (no file)'}`);
    }
    const layers = Array.isArray(output?.layers) ? output.layers : [];
    if (layers.length) lines.push(`layers: ${layers.length}`);
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    if (warnings.length) {
        lines.push(`warnings: ${warnings.length}`);
        for (const message of warnings.slice(0, 10)) lines.push(`  ! ${message}`);
        if (warnings.length > 10) lines.push(`  ! …and ${warnings.length - 10} more`);
    }
    return lines;
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
    let stage = '';
    let stageStartedAt = Date.now();

    function event(e) {
        if (!e || !e.type) return;
        switch (e.type) {
            case 'plan':
                printPlan(e);
                break;
            case 'stage.start':
                stage = e.stage ?? '';
                stageStartedAt = Date.now();
                console.log(`[${e.stage}] ${e.label ?? e.stage}`);
                break;
            case 'stage.done':
                console.log(`[${e.stage}] done · ${formatDuration(Date.now() - stageStartedAt)}`);
                break;
            case 'stage.error':
                console.error(`[${e.stage}] failed: ${e.error}`);
                break;
            case 'activity':
                console.log(`[${stage || 'run'}] ${e.text}`);
                break;
            case 'role.start':
                console.log(`[${stage || 'run'}] ${roleLine(e)}`);
                break;
            case 'request.start':
                if (String(e.path ?? '').startsWith('images')) {
                    console.log(`[${stage || 'run'}] the picture model is working (${e.model ?? 'the editor'})`);
                }
                break;
            case 'request.retry':
                console.warn(`  retry ${e.attempt}: ${e.error}`);
                break;
            case 'request.error':
                console.warn(`  the host failed: ${e.error}`);
                break;
            case 'model.fallback':
                console.warn(`  the model ${e.from} failed: ${e.error} — trying ${e.to}`);
                break;
            case 'request.skip':
                console.log(`  the host ${e.backend} is skipped: ${e.reason}`);
                break;
            case 'transport.fallback':
            case 'transport.adjust':
                console.log(`  ${e.reason}`);
                break;
            case 'extend.attempt':
                console.log(`[${stage || 'run'}] the picture model paints the band (attempt ${e.attempt}/${e.maxAttempts})`);
                break;
            case 'extend.decision':
                if (e.verdict === 'keep') {
                    console.log(`[${stage || 'run'}] the frame is complete: ${e.assessment ?? 'nothing is cut'}`);
                } else {
                    const edges = Array.isArray(e.edges) ? e.edges : [e.edge].filter(Boolean);
                    console.log(`[${stage || 'run'}] the frame is cut at ${edges.join(' + ') || 'no edge'}`
                        + `${e.band ? ` — the band is ${e.band} px` : ''}`
                        + `${e.after ? `, the canvas grows to ${e.after.width}×${e.after.height}` : ''}`);
                }
                break;
            case 'extend.done':
                console.log(`  extended: ${e.file} → ${e.to} (${e.width}×${e.height})`);
                break;
            case 'decompose.cut':
                console.log(`  cut: ${e.screen} → ${e.file}${e.existing ? ' (already there)' : ''}`);
                break;
            case 'decompose.screens':
                console.log(`  screens: ${e.screens}, files: ${e.files}`
                    + `${Array.isArray(e.names) && e.names.length ? ` (${e.names.join(', ')})` : ''}`);
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
            case 'rectify.projected':
                console.log(`  projected: ${e.file}${e.screen ? ` (${e.screen})` : ''}`);
                break;
            case 'rectify.recut':
                console.log(`  re-cut: ${e.file}${e.screen ? ` (${e.screen})` : ''} — the screen was cut off`);
                break;
            case 'rectify.file':
                console.log(`  rectified: ${e.file}${e.screen ? ` (${e.screen})` : ''}`);
                break;
            case 'reconstruct.file':
                if (verbose) console.log(`  restored: ${e.file}`);
                break;
            case 'reconstruct.geometry':
                console.log(`  geometry: ${e.file} — tilt ${e.rotateDeg ?? 0}°, size ${e.scalePercent ?? 0}% `
                    + `(${e.before ?? 0}° → ${e.after ?? 0}°, ${e.status})`);
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
            case 'resolve.layers':
                if (verbose) console.log(`  layers: ${e.count}`);
                break;
            case 'resolve.json':
                console.log(`  the decomposition is written: ${e.path} (${e.screens} screens)`);
                break;
            case 'resolve.done':
                console.log(`  output: ${e.path} (${e.screens} screens, ${e.layers} layers)`);
                break;
            case 'warning':
                console.warn(`  warning: ${e.message}`);
                break;
            case 'text.delta':
            case 'reasoning.delta':
            case 'refusal.delta':
                break;
            case 'text.done':
                if (verbose) console.log(`  ${e.text}`);
                break;
            case 'reasoning.done':
                if (verbose) console.log(`  thinking: ${e.text}`);
                break;
            case 'response.created':
            case 'response.status':
            case 'reasoning.start':
            case 'message.start':
            case 'item.done':
            case 'tool.call.start':
            case 'tool.args.delta':
            case 'tool.args.done':
                break;
            case 'stream.error':
                console.warn(`  the stream failed: ${e.message}`);
                break;
            default:
                if (verbose) console.log(`  [${e.type}]`, JSON.stringify(e));
        }
    }

    /**
     * Print the final summary of the run.
     * @param {object} result the result of the pipeline
     * @returns {void}
     */
    function summary(result) {
        console.log('Done.');
        for (const line of summaryLines(result)) console.log(`  ${line}`);
    }

    return { event, summary };
}

/**
 * Create a renderer for pipeline events.
 *
 * The renderer keeps one live line: the stage header stays, the line under it shows the
 * work of the moment and the time it has been going on. Every other line of the run is
 * written above it, so the reader always sees where the run is.
 * @param {{ verbose?: boolean }} opts
 * @returns {{ event: (e: object) => void }}
 */
export function createRenderer({ verbose = false } = {}) {
    let stageLabel = '';
    let activity = '';
    let stageStartedAt = Date.now();
    let stageRunning = false;
    let ticker = null;
    let frame = 0;
    let width = 0;

    /**
     * Erase the live line.
     * @returns {void}
     */
    const erase = () => {
        if (!width) return;
        process.stdout.write(`\r${' '.repeat(width)}\r`);
        width = 0;
    };

    /**
     * Write the live line, padded to the width of the previous one.
     * @param {string} text
     * @returns {void}
     */
    const draw = (text) => {
        const padded = text.padEnd(width);
        width = text.length;
        process.stdout.write(`\r${padded}`);
    };

    /**
     * The text of the live line right now.
     * @returns {string}
     */
    const liveText = () => `${SPINNER[frame]} ${activity || 'working'} · ${formatDuration(Date.now() - stageStartedAt)}`;

    /**
     * Start the ticker that refreshes the live line.
     * @returns {void}
     */
    const startTicker = () => {
        if (ticker || !stageRunning) return;
        draw(liveText());
        ticker = setInterval(() => {
            frame = (frame + 1) % SPINNER.length;
            draw(liveText());
        }, TICK_MS);
        ticker.unref?.();
    };

    /**
     * Stop the ticker and erase the live line.
     * @returns {void}
     */
    const stopTicker = () => {
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        erase();
    };

    /**
     * Change the work the live line shows.
     * @param {string} text
     * @returns {void}
     */
    const setActivity = (text) => {
        activity = text;
        if (!ticker) return;
        draw(liveText());
    };

    /**
     * Write a line above the live line.
     * @param {string} text
     * @returns {void}
     */
    const say = (text) => {
        stopTicker();
        console.log(text);
        startTicker();
    };
    function event(e) {
        if (!e || !e.type) return;
        switch (e.type) {
            case 'plan':
                stopTicker();
                printPlan(e);
                break;
            case 'stage.start':
                stopTicker();
                stageLabel = e.label ?? e.stage;
                stageStartedAt = Date.now();
                stageRunning = true;
                activity = '';
                console.log(paint(`▶ ${stageLabel}`, COLORS.cyan));
                startTicker();
                break;
            case 'stage.done':
                stopTicker();
                stageRunning = false;
                console.log(paint(`  ✓ ${e.stage} · ${formatDuration(Date.now() - stageStartedAt)}`, COLORS.green));
                break;
            case 'stage.error':
                stopTicker();
                stageRunning = false;
                console.error(paint(`  ✗ ${e.stage}: ${e.error}`, COLORS.red));
                break;
            case 'activity':
                setActivity(String(e.text ?? ''));
                break;
            case 'role.start':
                setActivity(roleLine(e));
                break;
            case 'role.done':
                setActivity('');
                break;
            case 'extend.attempt':
                setActivity(`the picture model paints the band (attempt ${e.attempt}/${e.maxAttempts})`);
                break;
            case 'request.start':
                // A picture comes in one piece and takes a while: the reader is told that
                // the picture model is at work.
                if (String(e.path ?? '').startsWith('images')) {
                    setActivity(`the picture model is working (${e.model ?? 'the editor'})`);
                }
                break;
            case 'request.retry':
                say(paint(`  ↻ the host did not answer, retry ${e.attempt}: ${e.error}`, COLORS.yellow));
                break;
            case 'request.error':
                say(paint(`  ⚠ the host failed: ${e.error}`, COLORS.yellow));
                break;
            case 'model.fallback':
                say(paint(`  ⚠ the model ${e.from} failed: ${e.error} — trying ${e.to}`, COLORS.yellow));
                break;
            case 'request.skip':
                say(paint(`  · the host ${e.backend} is skipped: ${e.reason}`, COLORS.dim));
                break;
            case 'transport.fallback':
            case 'transport.adjust':
                say(paint(`  · ${e.reason}`, COLORS.dim));
                break;
            case 'extend.decision':
                if (e.verdict === 'keep') {
                    say(paint(`  · the frame is complete: ${e.assessment ?? 'nothing is cut'}`, COLORS.dim));
                } else {
                    const edges = Array.isArray(e.edges) ? e.edges : [e.edge].filter(Boolean);
                    say(paint(`  · the frame is cut at ${edges.join(' + ') || 'no edge'}`
                        + `${e.band ? ` — the band is ${e.band} px` : ''}`
                        + `${e.after ? `, the canvas grows to ${e.after.width}×${e.after.height}` : ''}`, COLORS.dim));
                }
                break;
            case 'extend.done':
                say(paint(`  extended: ${e.file} → ${e.to} (${e.width}×${e.height})`, COLORS.dim));
                break;
            case 'decompose.cut':
                say(paint(`  cut: ${e.screen} → ${e.file}${e.existing ? ' (already there)' : ''}`, COLORS.dim));
                break;
            case 'decompose.screens':
                say(paint(`  screens: ${e.screens}, files: ${e.files}`
                    + `${Array.isArray(e.names) && e.names.length ? ` (${e.names.join(', ')})` : ''}`, COLORS.dim));
                break;
            case 'decompose.done':
                say(paint(`  screens: ${e.screens}, files: ${e.files}`, COLORS.dim));
                break;
            case 'decompose.report':
                if (verbose) say(e.report);
                break;
            case 'rectify.done':
                say(paint(`  rectified: ${e.count}`, COLORS.dim));
                break;
            case 'rectify.projected':
                say(paint(`  projected: ${e.file}${e.screen ? ` (${e.screen})` : ''}`, COLORS.dim));
                break;
            case 'rectify.recut':
                say(paint(`  re-cut: ${e.file}${e.screen ? ` (${e.screen})` : ''} — the screen was cut off`, COLORS.dim));
                break;
            case 'rectify.file':
                say(paint(`  rectified: ${e.file}${e.screen ? ` (${e.screen})` : ''}`, COLORS.dim));
                break;
            case 'reconstruct.file':
                if (verbose) say(`  restored: ${e.file}`);
                break;
            case 'reconstruct.geometry':
                say(paint(`  geometry: ${e.file} — tilt ${e.rotateDeg ?? 0}°, size ${e.scalePercent ?? 0}% `
                    + `(${e.before ?? 0}° → ${e.after ?? 0}°, ${e.status})`, COLORS.dim));
                break;
            case 'reconstruct.done':
                say(paint(`  restored: ${e.file} (${e.status})`, COLORS.dim));
                break;
            case 'overlap.file':
                if (verbose) say(`  overlap cleaned: ${e.file}`);
                break;
            case 'overlap.done':
                say(paint(`  overlap resolved: ${e.count}`, COLORS.dim));
                break;
            case 'resolve.layers':
                if (verbose) say(`  layers: ${e.count}`);
                break;
            case 'resolve.json':
                say(paint(`  the decomposition is written: ${e.path} (${e.screens} screens)`, COLORS.dim));
                break;
            case 'resolve.done':
                say(paint(`  output: ${e.path} (${e.screens} screens, ${e.layers} layers)`, COLORS.bold));
                break;
            case 'warning':
                say(paint(`  ⚠ ${e.message}`, COLORS.yellow));
                break;
            case 'text.delta':
            case 'reasoning.delta':
            case 'refusal.delta':
                // The stream is a firehose: only the finished chunks are worth a line.
                break;
            case 'text.done':
                if (verbose) say(`  ${e.text}`);
                break;
            case 'reasoning.done':
                if (verbose) say(paint(`  thinking: ${e.text}`, COLORS.dim));
                break;
            case 'response.created':
            case 'response.status':
            case 'reasoning.start':
            case 'message.start':
            case 'item.done':
            case 'tool.call.start':
            case 'tool.args.delta':
            case 'tool.args.done':
                break;
            case 'stream.error':
                say(paint(`  ⚠ the stream failed: ${e.message}`, COLORS.yellow));
                break;
            default:
                if (verbose) say(`  [${e.type}] ${JSON.stringify(e)}`);
        }
    }

    /**
     * Print the final summary of the run.
     * @param {object} result the result of the pipeline
     * @returns {void}
     */
    function summary(result) {
        stopTicker();
        console.log(paint('Done.', COLORS.bold));
        for (const line of summaryLines(result)) {
            console.log(paint(`  ${line}`, line.startsWith('!') ? COLORS.yellow : COLORS.dim));
        }
    }

    return { event, summary };
}
