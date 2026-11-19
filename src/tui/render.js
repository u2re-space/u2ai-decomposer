/**
 * @file src/tui/render.js
 * @module tui/render
 * @purpose Draw the state of the worker as a small terminal dashboard.
 *
 *   The dashboard has three parts: the header with the run and its progress, the
 *   stages on the left, the live output of the worker on the right, and the operator
 *   line at the bottom. The layout is built as plain text first, so it can be tested
 *   without a terminal.
 *
 * @depends cli/stdio
 * @usedBy tui/app
 * @exports truncate, formatStatusRow, createTuiLayout, renderTui
 * @ai.tags tui, terminal, layout
 */

import { sanitizeText } from '../cli/stdio.js';

/**
 * Cut a text to the width of a terminal cell.
 * @param {unknown} value
 * @param {number} width
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function truncate(value, width) {
    const limit = Math.max(0, Math.floor(Number(width) || 0));
    if (!limit) return '';
    const chars = Array.from(sanitizeText(value).replace(/\s+/g, ' ').trim());
    if (chars.length <= limit) return chars.join('');
    if (limit === 1) return '…';
    return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * The symbols of the interface.
 * @param {boolean} ascii
 * @returns {object}
 * @ai.hint pure
 */
function symbols(ascii) {
    return ascii
        ? { ok: '+', fail: 'x', skip: '->', run: '>', wait: '...', rule: '-', barFull: '#', barEmpty: '.' }
        : { ok: '✓', fail: '✗', skip: '→', run: '▸', wait: '…', rule: '─', barFull: '█', barEmpty: '░' };
}

/**
 * The mark of one stage.
 * @param {object} stage
 * @param {object} marks
 * @returns {string}
 * @ai.hint pure
 */
function stageMark(stage, marks) {
    const status = String(stage?.status ?? 'pending');
    if (status === 'completed') return marks.ok;
    if (status === 'failed' || status === 'partial') return marks.fail;
    if (status === 'skipped' || status === 'paused') return marks.skip;
    if (status === 'running') return marks.run;
    return marks.wait;
}

/**
 * Choose the stages that fit into the left pane.
 * @param {object} state
 * @param {number} rows
 * @returns {object[]}
 * @ai.hint pure
 */
function visibleStages(state, rows) {
    const all = Object.values(state?.stages ?? {});
    const active = all.filter((stage) => stage?.status === 'running');
    const seen = all.filter((stage) => stage?.status && stage.status !== 'pending' && stage.status !== 'running');
    const pending = all.filter((stage) => stage?.status === 'pending');
    const out = [];
    const add = (stage) => {
        if (!stage || out.some((item) => item.name === stage.name)) return;
        out.push(stage);
    };
    active.forEach(add);
    seen.slice(-Math.max(1, rows - out.length)).forEach(add);
    for (const stage of pending) {
        if (out.length >= rows) break;
        add(stage);
    }
    return out.slice(0, rows);
}

/**
 * Build the status row shown directly above the operator input.
 *
 * The row is the compact view of the current work: its model, stage, role, effort,
 * mode, plan step and state. A pending question goes first, because the answer of the
 * operator is the most immediate action.
 *
 * @param {object} state
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatStatusRow(state) {
    const location = state?.location ?? {};
    const running = Object.values(state?.stages ?? {})
        .find((stage) => stage?.status === 'running');
    const text = (value) => String(value ?? '').trim();
    const fields = [
        `Model: ${text(location.model) || '—'}`,
        `Stage: ${text(location.stage) || text(running?.name) || '—'}`,
        `Role: ${text(location.role) || '—'}`,
        `Effort: ${text(location.effort) || '—'}`,
        `Mode: ${text(location.mode) || '—'}`,
    ];
    if (text(location.step)) fields.push(`Step: ${text(location.step)}`);
    fields.push(`Status: ${text(state?.statusText) || text(state?.status) || 'starting'}`);
    const question = state?.question ?? null;
    if (question) fields.unshift(`Question: ${text(question.question) || 'Input'}`);
    return fields.join(' · ');
}

/**
 * Build the lines of the dashboard.
 *
 * @param {object} state
 * @param {{ width?: number, height?: number, input?: string, ascii?: boolean,
 *   logOffset?: number }} [options]
 * @returns {{ lines: object[], inputRow: number, statusRow: number, progressRow: number }}
 * @exports
 * @ai.hint pure
 */
export function createTuiLayout(state, {
    width = 100,
    height = 30,
    input = '',
    ascii = false,
    logOffset = 0,
} = {}) {
    const wantedWidth = Math.floor(Number(width));
    const wantedHeight = Math.floor(Number(height));
    const cols = Math.max(56, Number.isFinite(wantedWidth) && wantedWidth > 0 ? wantedWidth : 100);
    const rows = Math.max(12, Number.isFinite(wantedHeight) && wantedHeight > 0 ? wantedHeight : 30);
    const marks = symbols(ascii);
    const lines = [];
    const push = (text = '', style = 'normal') => lines.push({ text: String(text), style });

    const observed = Array.isArray(state?.observed) ? state.observed : [];
    const done = observed.filter((name) => {
        const status = state?.stages?.[name]?.status;
        return status && status !== 'pending' && status !== 'running';
    }).length;
    const total = observed.length;
    const barWidth = Math.max(8, Math.min(24, Math.floor(cols * 0.22)));
    const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
    const bar = `${marks.barFull.repeat(filled)}${marks.barEmpty.repeat(Math.max(0, barWidth - filled))}`;

    const command = String(state?.command || 'run');
    const header = truncate(`ai-webdev · ${command}`, cols);
    push(header, 'title');
    push(truncate(state?.task || 'Preparing the run…', cols), 'dim');
    push(marks.rule.repeat(cols), 'dim');

    const footerRows = 8;
    const headerRows = lines.length;
    const mainRows = Math.max(3, rows - headerRows - footerRows - 1);
    const leftWidth = Math.max(24, Math.min(44, Math.floor(cols * 0.38)));
    const rightWidth = cols - leftWidth - 3;
    const stageRows = visibleStages(state, mainRows);
    const logRows = state?.logs ?? [];
    const maxOffset = Math.max(0, logRows.length - mainRows);
    const offset = Math.min(Math.max(0, Number(logOffset) || 0), maxOffset);
    const firstLog = Math.max(0, logRows.length - mainRows - offset);

    push(`${'Stages'.padEnd(leftWidth)} │ Live log`, 'title');
    push(`${marks.rule.repeat(leftWidth)}─┼─${marks.rule.repeat(Math.max(0, rightWidth))}`, 'dim');

    for (let row = 0; row < mainRows; row += 1) {
        const stage = stageRows[row] ?? null;
        const stageText = stage
            ? `${stageMark(stage, marks)} ${stage.name} — ${stage.title ?? ''}`
            : '';
        const log = logRows[firstLog + row] ?? null;
        const logPrefix = log?.stream === 'stdout' ? '[out] ' : '[log] ';
        const logText = log ? `${logPrefix}${log.line}` : '';
        const left = truncate(stageText, leftWidth).padEnd(leftWidth);
        const right = truncate(logText, rightWidth).padEnd(rightWidth);
        push(`${left} │ ${right}`, 'normal');
    }

    push(marks.rule.repeat(cols), 'dim');
    const progressText = total > 0 ? `${bar} ${done}/${total}` : `${bar} 0/0`;
    const notice = String(state?.notice ?? '');
    const progressRow = lines.length;
    push(`${truncate(progressText, Math.floor(cols * 0.45))}  ${truncate(notice, Math.floor(cols * 0.5))}`, 'normal');
    const question = state?.question ?? null;
    push(marks.rule.repeat(cols), 'dim');
    const statusRow = lines.length;
    push(truncate(formatStatusRow(state), cols), question ? 'warn' : 'dim');
    push(marks.rule.repeat(cols), 'dim');
    const inputRow = lines.length;
    push(truncate('text: steer · /skip [name] · /help · /quit · Ctrl+C: stop', cols), 'dim');
    push(truncate(`› ${input}`, cols), 'normal');
    return { lines, inputRow, statusRow, progressRow };
}

/**
 * Draw the dashboard in a terminal.
 * @param {object} term a terminal-kit terminal
 * @param {object} state
 * @param {{ input?: string, ascii?: boolean, logOffset?: number }} [options]
 * @returns {void}
 * @exports
 * @ai.hint io
 */
export function renderTui(term, state, { input = '', ascii = false, logOffset = 0 } = {}) {
    const measuredWidth = Math.floor(Number(term?.width));
    const measuredHeight = Math.floor(Number(term?.height));
    const width = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : 100;
    const height = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 30;
    const layout = createTuiLayout(state, { width, height, input, ascii, logOffset });
    term.clear();
    const styleNames = { title: 'bold', good: 'green', bad: 'red', warn: 'yellow', dim: 'dim' };
    layout.lines.forEach((line, index) => {
        term.moveTo(1, index + 1);
        term.eraseLineAfter();
        const styleName = styleNames[line.style] ?? 'normal';
        const style = typeof term?.[styleName] === 'function' ? term[styleName] : term;
        style(line.text);
    });
    const inputCells = Array.from(String(input ?? '')).length;
    const cursorColumn = Math.min(width, 3 + inputCells);
    term.moveTo(cursorColumn, layout.inputRow + 2);
    term.hideCursor(false);
}
