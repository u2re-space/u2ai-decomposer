/**
 * @file src/access/exec.js
 * @module access/exec
 * @purpose The commands of the run, seen through a backend.
 *
 *   The module knows the shape of a command and nothing about the shell: it asks the
 *   backend to run the program and decides what may be run. The working directory comes
 *   from the root of the run — a command may not work outside it.
 *
 *   The backend is a small object:
 *
 *   ```js
 *   {
 *     run(command, args, { cwd, timeoutMs, env, signal }) -> { code, stdout, stderr, timedOut },
 *   }
 *   ```
 *
 * @depends node:path, access/paths
 * @usedBy access/index, agent/paths
 * @exports EXEC_LIMITS, createCommandRunner
 * @ai.tags exec, commands, access
 * @ai.hint io
 */

import path from 'node:path';
import { resolveInside } from './paths.js';

/** The limits of the commands. */
export const EXEC_LIMITS = Object.freeze({
    timeoutMs: 180_000,
    outputBytes: 64 * 1024,
});

/**
 * The runner of the commands of one root.
 *
 * @param {{ root: string, backend: object, env?: object, timeoutMs?: number, outputBytes?: number,
 *           probe?: { lstat?: Function, realpath?: Function }|null, messages?: object }} options
 * @returns {object} the facade of the commands
 * @exports
 * @ai.hint io
 */
export function createCommandRunner({ root, backend, env = process.env, timeoutMs = EXEC_LIMITS.timeoutMs, outputBytes = EXEC_LIMITS.outputBytes, probe = null, messages = {} } = {}) {
    if (!backend || typeof backend.run !== 'function') {
        throw new Error('The access needs a backend of the commands.');
    }
    const base = path.resolve(String(root ?? process.cwd()));
    const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : EXEC_LIMITS.timeoutMs;

    /**
     * Cut the output to the limit.
     * @param {string} value
     * @returns {string}
     */
    const cut = (value) => {
        const text = String(value ?? '');
        return text.length > outputBytes ? `${text.slice(0, outputBytes)}…` : text;
    };

    /**
     * Run one command.
     *
     * @param {string} command the program to run
     * @param {string[]} [args] the arguments of the program
     * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal|null, env?: object|null }} [options]
     * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>}
     */
    const run = async (command, args = [], { cwd = '.', timeoutMs: own = null, signal = null, env: ownEnv = null } = {}) => {
        const program = String(command ?? '').trim();
        if (!program) throw new Error('The command is missing.');
        const list = Array.isArray(args) ? args.map(String) : [];
        const { abs } = await resolveInside(base, cwd ?? '.', {
            allowRoot: true,
            messages,
            ...(typeof probe?.lstat === 'function' ? { lstat: probe.lstat } : {}),
            ...(typeof probe?.realpath === 'function' ? { realpath: probe.realpath } : {}),
        });
        const answer = await backend.run(program, list, {
            cwd: abs,
            timeoutMs: Number.isSafeInteger(own) && own > 0 ? own : limit,
            env: ownEnv ?? env,
            signal,
        });
        const code = Number.isInteger(answer?.code) ? answer.code : 1;
        return {
            ok: code === 0 && !answer?.timedOut,
            code,
            stdout: cut(answer?.stdout),
            stderr: cut(answer?.stderr),
            timedOut: Boolean(answer?.timedOut),
        };
    };

    return { root: base, run, timeoutMs: limit };
}
