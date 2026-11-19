/**
 * @file src/tui/state.js
 * @module tui/state
 * @purpose The pure state of the graphical shell.
 *
 *   The shell does not draw from the worker's text. It folds the protocol frames and
 *   the live output of the worker into one state: the stages, the progress, the log,
 *   the pending question and the final result. The reducer is pure so every part of
 *   the interface can be tested without a terminal.
 *
 * @depends shared/pipeline
 * @usedBy tui/app, tui/render
 * @exports LOG_LIMIT, createTuiState, reduceTuiState
 * @ai.tags tui, state, reducer
 */

import { STAGES } from '../shared/pipeline.js';

/** How many lines the shell keeps in memory. */
export const LOG_LIMIT = 1000;

/**
 * The initial state of the shell.
 * @param {{ command?: string, task?: string }} [options]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createTuiState({ command = '', task = '' } = {}) {
    const stages = {};
    for (const stage of STAGES) {
        stages[stage.id] = {
            name: stage.id,
            title: stage.label,
            status: 'pending',
        };
    }
    return {
        command: String(command ?? ''),
        task: String(task ?? ''),
        status: 'starting',
        exitCode: null,
        pid: null,
        protocol: null,
        stages,
        observed: [],
        logs: [],
        outputs: [],
        question: null,
        location: null,
        statusText: '',
        progress: null,
        plan: null,
        summary: null,
        notice: '',
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };
}

/**
 * Add one line to a bounded list.
 * @param {object[]} list
 * @param {object} item
 * @returns {object[]}
 * @ai.hint pure
 */
function appendLimited(list, item) {
    const next = [...list, item];
    return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
}

/**
 * Add a stage to the observed list of the run.
 * @param {object} state
 * @param {string} name
 * @returns {object[]}
 * @ai.hint pure
 */
function observeStage(state, name) {
    const key = String(name ?? '').trim();
    if (!key || state.observed.includes(key)) return state.observed;
    return [...state.observed, key];
}

/**
 * Update one stage of the run.
 * @param {object} state
 * @param {string} name
 * @param {string} status
 * @param {string} [title]
 * @returns {object}
 * @ai.hint pure
 */
function withStage(state, name, status, title = '') {
    const key = String(name ?? '').trim();
    if (!key) return state;
    const old = state.stages[key] ?? { name: key, title: String(title ?? ''), status: 'pending' };
    return {
        ...state,
        observed: observeStage(state, key),
        stages: {
            ...state.stages,
            [key]: { ...old, title: String(title ?? '') || old.title, status: String(status ?? 'pending') },
        },
    };
}

/**
 * The number of finished and observed stages.
 * @param {object} state
 * @returns {{ done: number, total: number }}
 * @ai.hint pure
 */
export function stageProgress(state) {
    const observed = Array.isArray(state?.observed) ? state.observed : [];
    let done = 0;
    for (const name of observed) {
        const status = state?.stages?.[name]?.status;
        if (status && status !== 'pending' && status !== 'running') done += 1;
    }
    return { done, total: observed.length };
}

/**
 * Fold one worker event into the state.
 * @param {object} state
 * @param {object} event
 * @returns {object}
 * @ai.hint pure
 */
function reduceEvent(state, event) {
    const type = String(event?.type ?? '');
    if (type === 'stage.start') {
        return withStage(state, event.stage, 'running', event.title);
    }
    if (type === 'stage.done') {
        return withStage(state, event.stage, event.status ?? 'completed');
    }
    if (type === 'stage.skip') {
        return withStage(state, event.stage, 'skipped');
    }
    if (type === 'plan') {
        return { ...state, plan: event.payload ?? event.plan ?? null };
    }
    if (type === 'progress') {
        return { ...state, progress: event.payload ?? event.progress ?? null };
    }
    if (type === 'summary') {
        const report = event.payload ?? event.report ?? null;
        const status = String(report?.status ?? '');
        return {
            ...state,
            summary: report,
            status: status === 'completed' ? 'completed' : (status ? status : state.status),
        };
    }
    if (type === 'files') {
        const files = Array.isArray(event.payload?.files) ? event.payload.files : [];
        return { ...state, notice: files.length ? `Files: ${files.join(', ')}` : state.notice };
    }
    if (type === 'warning') {
        const text = String(event.payload?.text ?? event.text ?? event.payload?.message ?? event.message ?? '');
        return text ? { ...state, notice: text } : state;
    }
    if (type === 'error') {
        const text = String(event.payload?.text ?? event.text ?? event.payload?.message ?? event.message ?? '');
        return text ? { ...state, notice: text } : state;
    }
    if (type === 'role.done') {
        const role = String(event.role ?? 'role');
        const stopped = String(event.stopped ?? 'completed');
        return { ...state, notice: `${role}: ${stopped}` };
    }
    if (type === 'request.wait') {
        const seconds = Number(event.seconds ?? Math.round(Number(event.elapsedMs ?? 0) / 1000));
        return { ...state, notice: `thinking (${seconds}s)` };
    }
    if (type === 'request.retry' || type === 'request.error' || type === 'stream.error') {
        const text = String(event.error ?? event.message ?? 'request failed');
        return { ...state, notice: text };
    }
    return state;
}

/**
 * Reduce one action of the shell.
 *
 * An action is either a protocol frame or a line of the worker's ordinary output.
 *
 * @param {object} state
 * @param {{ type: string, frame?: object, stream?: string, line?: string }} action
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function reduceTuiState(state, action) {
    const current = state ?? createTuiState();
    const type = String(action?.type ?? '');
    if (type === 'log' || type === 'output') {
        const line = String(action.line ?? '').replace(/\r$/, '');
        if (!line.trim()) return current;
        const item = { at: new Date().toISOString(), stream: action.stream ?? 'stderr', line };
        const logs = appendLimited(current.logs, item);
        if (type === 'output') return { ...current, logs, outputs: appendLimited(current.outputs, item) };
        return { ...current, logs };
    }
    if (type === 'answer') {
        return { ...current, question: null };
    }
    if (type !== 'frame') return current;

    const frame = action.frame ?? {};
    if (frame.type === 'ready') {
        return { ...current, status: 'running', pid: frame.pid ?? null, protocol: frame.v ?? null };
    }
    if (frame.type === 'event') {
        return reduceEvent(current, frame.event ?? {});
    }
    if (frame.type === 'question') {
        return {
            ...current,
            question: {
                id: String(frame.id ?? ''),
                kind: String(frame.kind ?? 'question'),
                question: String(frame.question ?? ''),
            },
            notice: '',
        };
    }
    if (frame.type === 'status') {
        return {
            ...current,
            location: frame.location ?? current.location,
            statusText: String(frame.status ?? ''),
        };
    }
    if (frame.type === 'error') {
        return {
            ...current,
            status: 'failed',
            notice: String(frame.message ?? 'worker error'),
            finishedAt: new Date().toISOString(),
        };
    }
    if (frame.type === 'result') {
        const code = Number(frame.code ?? 0);
        return {
            ...current,
            status: code === 0 ? 'completed' : 'failed',
            exitCode: code,
            question: null,
            finishedAt: new Date().toISOString(),
        };
    }
    return current;
}
