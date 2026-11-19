/**
 * @file src/tui/worker-client.js
 * @module tui/worker-client
 * @purpose The client of the internal worker used by the graphical shell.
 *
 *   The worker is a real child process. Its stdout and stderr stay classic and are
 *   read line by line for the log pane. The IPC channel carries the structured
 *   events, the questions of the operator and the commands of the shell.
 *
 * @depends node:child_process, node:path, node:url, cli/protocol, shared/child-log
 * @usedBy tui/app, tui/cli
 * @exports WORKER_PATH, createWorkerClient
 * @ai.tags tui, worker, process
 * @ai.hint io
 */

import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, createFrame, isFrame } from '../cli/protocol.js';
import { createLineReader } from '../shared/child-log.js';

/** The entry of the internal worker. */
export const WORKER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ai-decompose-worker.js');

/**
 * Start the internal worker and connect the shell to it.
 *
 * @param {{ args?: string[], cwd?: string, env?: object, onFrame?: Function,
 *   onLog?: Function, onError?: Function }} [options]
 * @returns {object}
 * @exports
 * @ai.hint io
 */
export function createWorkerClient({
    args = [],
    cwd = process.cwd(),
    env = process.env,
    onFrame = () => {},
    onLog = () => {},
    onError = () => {},
} = {}) {
    const child = fork(WORKER_PATH, args.map(String), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [],
        windowsHide: true,
    });

    const stdout = createLineReader((line) => onLog({ stream: 'stdout', line }));
    const stderr = createLineReader((line) => onLog({ stream: 'stderr', line }));
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));

    let exit = null;
    let resolveExit = null;
    const finished = new Promise((resolve) => { resolveExit = resolve; });

    child.on('message', (frame) => {
        if (!isFrame(frame)) {
            onError(new Error(`The worker sent an invalid protocol frame: ${JSON.stringify(frame)}`));
            return;
        }
        onFrame(frame);
    });
    child.on('error', (error) => {
        onError(error);
    });
    child.on('exit', (code, signal) => {
        stdout.flush();
        stderr.flush();
        exit = { code: Number(code ?? (signal ? 1 : 0)), signal: signal ?? null };
        resolveExit(exit);
    });

    return {
        child,
        pid: child.pid ?? null,
        finished,

        /**
         * Send one frame to the worker.
         * @param {string} type
         * @param {object} [payload]
         * @returns {boolean}
         */
        send(type, payload = {}) {
            if (!child.connected) return false;
            try {
                child.send(createFrame(type, payload));
                return true;
            } catch (error) {
                onError(error);
                return false;
            }
        },

        /**
         * Send operator text to the worker.
         * @param {string} text
         * @returns {boolean}
         */
        steer(text) {
            return this.send(FRAME.input, { text: String(text ?? '') });
        },

        /**
         * Answer a question of the worker.
         * @param {string} id
         * @param {string} text
         * @returns {boolean}
         */
        answer(id, text) {
            return this.send(FRAME.answer, { id: String(id ?? ''), text: String(text ?? '') });
        },

        /**
         * Send a control command to the worker.
         * @param {string} name
         * @param {string|null} [target]
         * @returns {boolean}
         */
        command(name, target = null) {
            return this.send(FRAME.command, { name: String(name ?? ''), target });
        },

        /**
         * Stop the worker.
         * @returns {void}
         */
        close() {
            if (!child.connected) {
                child.kill();
                return;
            }
            try {
                child.disconnect();
            } catch {
                // The worker is already gone.
            }
        },
    };
}
