/**
 * @file src/cli/worker.js
 * @module cli/worker
 * @purpose The internal process of ai-measure: classic output plus the protocol of the shell.
 *
 *   The worker owns the whole CLI and writes its ordinary result to stdout and its
 *   ordinary log to stderr. A separate IPC channel carries the events of the run,
 *   the questions of the operator and the commands that steer the worker. The shell
 *   never has to guess the state of the run from the text on the screen.
 *
 * @depends node:process, cli, cli/input-state, cli/protocol, cli/renderer, cli/stdio
 * @usedBy bin/ai-measure-worker
 * @exports createWorkerInput, createWorkerRenderer, mainWorker
 * @ai.tags cli, worker, ipc
 * @ai.hint io
 */

import { main, parseArgv } from '../cli.js';
import { createInputState } from './input-state.js';
import { createFrame, FRAME, isFrame, questionId } from './protocol.js';
import { createPlainRenderer, createRenderer, detectMode } from './renderer.js';
import { sanitizeText } from './stdio.js';

/**
 * Create the operator channel of a worker.
 *
 * The channel has the same public surface as the terminal input channel. The core of
 * the run therefore does not know whether the operator types into a terminal or sends
 * an IPC frame from the graphical shell.
 *
 * @param {{ send?: (frame: object) => void, stderr?: object, onAbort?: Function }} [options]
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createWorkerInput({ send = () => {}, stderr = process.stderr, onAbort = () => {} } = {}) {
    const state = createInputState();
    const questions = new Map();
    let closed = false;
    let waitResolver = null;

    /**
     * Ask the operator a question and wait for the answer.
     * @param {string} question
     * @param {string} kind the kind of the question
     * @returns {Promise<string>}
     */
    const ask = async (question, kind) => {
        if (closed) return '';
        const id = questionId();
        const text = String(question ?? 'Input');
        send(createFrame(FRAME.question, { id, kind, question: text }));
        return await new Promise((resolve) => {
            questions.set(id, resolve);
        });
    };

    return {
        interactive: true,

        async readTask() {
            return await ask('Task', 'task');
        },

        async askUser(question) {
            return await ask(question, 'ask_user');
        },

        async prompt(question) {
            return await ask(question, 'prompt');
        },

        takeSteering() {
            return state.takeSteering();
        },

        setLocation(next) {
            const previous = state.location() ?? {};
            const incoming = next && typeof next === 'object' ? next : {};
            const stageChanged = incoming.stage && incoming.stage !== previous.stage;
            const location = { ...previous };
            if (stageChanged) {
                delete location.role;
                delete location.step;
                delete location.effort;
            }
            for (const [key, value] of Object.entries(incoming)) {
                if (value !== undefined && value !== null && value !== '') location[key] = value;
            }
            state.setLocation(location);
            const current = state.location();
            if (current) send(createFrame(FRAME.status, { location: current, status: '' }));
        },

        setStatus(text) {
            send(createFrame(FRAME.status, { location: state.location(), status: String(text ?? '') }));
        },

        log(text) {
            const body = sanitizeText(text);
            if (!body) return;
            stderr.write(body.endsWith('\n') ? body : `${body}\n`);
        },

        takeSkip({ stage = '', step = '' } = {}) {
            return state.takeSkip({ stage, step });
        },

        takeCurrentSkip() {
            return state.takeCurrentSkip();
        },

        takePendingSkips({ namedOnly = false, includeCurrent = false } = {}) {
            return state.takePendingSkips({ namedOnly, includeCurrent });
        },

        location() {
            return state.location();
        },

        queueStepSkip(id) {
            state.queueStepSkip(id);
        },

        takeStepSkip(id) {
            return state.takeStepSkip(id);
        },

        takeActiveStepSkip(id) {
            return state.takeStepSkip(id);
        },

        shouldQuit() {
            return state.shouldQuit();
        },

        taskPending() {
            return questions.size > 0;
        },

        waitForQuit() {
            if (state.shouldQuit() || closed) return Promise.resolve();
            return new Promise((resolve) => {
                waitResolver = resolve;
            });
        },

        commands: {
            help: 'The run answers on its own; /quit stops it safely.',
        },

        /**
         * Receive one frame from the shell.
         * @param {unknown} frame
         * @returns {boolean} whether the frame was accepted
         */
        receive(frame) {
            if (!isFrame(frame)) return false;
            if (frame.type === FRAME.input) {
                state.addSteering(frame.text ?? '');
                return true;
            }
            if (frame.type === FRAME.answer) {
                const resolve = questions.get(String(frame.id ?? ''));
                if (!resolve) return false;
                questions.delete(String(frame.id ?? ''));
                resolve(String(frame.text ?? ''));
                return true;
            }
            if (frame.type === FRAME.command) {
                const name = String(frame.name ?? '').trim().toLowerCase();
                if (name === 'skip') {
                    const target = frame.target ? String(frame.target).trim().toLowerCase() : null;
                    state.addSkip(target, state.location());
                    return true;
                }
                if (name === 'quit') {
                    state.requestQuit();
                    waitResolver?.();
                    waitResolver = null;
                    return true;
                }
                if (name === 'abort') {
                    state.requestQuit();
                    waitResolver?.();
                    waitResolver = null;
                    onAbort();
                    return true;
                }
            }
            return false;
        },

        close() {
            if (closed) return;
            closed = true;
            for (const resolve of questions.values()) resolve('');
            questions.clear();
            waitResolver?.();
            waitResolver = null;
        },
    };
}

/**
 * Add the protocol observations to the classic renderer of the worker.
 *
 * The classic renderer still writes its ordinary text. The proxy only copies the
 * semantic events that the graphical shell needs; the raw pipeline event is sent as
 * it is, so events unknown to the classic renderer are not lost.
 *
 * @param {object} renderer
 * @param {(frame: object) => void} send
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createWorkerRenderer(renderer, send) {
    return new Proxy(renderer, {
        get(target, property) {
            if (property === 'event') {
                return (event) => {
                    send(createFrame(FRAME.event, { event }));
                    target.event(event);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * Run the worker.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function mainWorker(argv = []) {
    const send = (frame) => {
        if (typeof process.send !== 'function') return Promise.resolve(false);
        return new Promise((resolve) => {
            try {
                process.send(frame, (error) => resolve(!error));
            } catch {
                // The shell may have gone away. The worker still has to finish its run.
                resolve(false);
            }
        });
    };

    const connected = typeof process.send === 'function';
    const input = connected
        ? createWorkerInput({
            send,
            stderr: process.stderr,
            onAbort: () => process.emit('SIGINT'),
        })
        : null;
    const parsed = parseArgv(argv);
    const mode = parsed.flags.json ? 'json' : (parsed.flags.quiet ? 'quiet' : 'plain');
    const classic = detectMode() === 'tty'
        ? createRenderer({ verbose: Boolean(parsed.flags.verbose), mode })
        : createPlainRenderer({ verbose: Boolean(parsed.flags.verbose), mode });
    const renderer = createWorkerRenderer(classic, send);
    const onMessage = (message) => input?.receive(message);
    if (connected) process.on('message', onMessage);

    send(createFrame(FRAME.ready, { pid: process.pid }));
    let code = 1;
    try {
        code = await main(argv, { renderer, input });
    } catch (error) {
        send(createFrame(FRAME.error, { message: error?.message ?? String(error) }));
        code = 1;
    }
    await send(createFrame(FRAME.result, { code }));
    input?.close();
    if (connected) process.off('message', onMessage);
    try {
        if (connected) process.disconnect?.();
    } catch {
        // The shell has already closed the channel.
    }
    return code;
}
