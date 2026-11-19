/**
 * @file src/tui/cli.js
 * @module tui/cli
 * @purpose The public entry of the graphical ai-decompose shell.
 *
 *   A terminal gets the dashboard. A pipe, a redirect, `--json` and `--quiet` keep the
 *   classic worker output, so automation and the bridges of the house do not have to
 *   know about the terminal interface.
 *
 * @depends node:child_process, node:module, help, cli, tui/app, tui/worker-client
 * @usedBy bin/ai-decompose
 * @exports mainTui
 * @ai.tags tui, cli, entry
 * @ai.hint io
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { HELP } from '../help.js';
import { parseArgv } from '../cli.js';
import { createTuiApp } from './app.js';
import { WORKER_PATH } from './worker-client.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/** The commands of the worker that the shell knows by name. */
const COMMANDS = new Set(['decompose']);

/**
 * Run the worker without a graphical interface.
 * @param {string[]} args
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function runHeadless(args) {
    return await new Promise((resolve) => {
        const child = spawn(process.execPath, [WORKER_PATH, ...args], {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit',
            windowsHide: true,
        });
        child.on('error', () => resolve(1));
        child.on('exit', (code, signal) => resolve(signal ? 130 : Number(code ?? 1)));
    });
}

/**
 * The public entry of the graphical shell.
 * @param {string[]} argv
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function mainTui(argv = []) {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    const parsed = parseArgv(args);

    if (parsed.flags.version || parsed.flags.v) {
        process.stdout.write(`${pkg.version}\n`);
        return 0;
    }
    if (parsed.flags.help || parsed.flags.h) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }

    const headless = Boolean(parsed.flags.json || parsed.flags.quiet || parsed.flags.headless)
        || !process.stdin.isTTY
        || !process.stdout.isTTY;
    if (headless) {
        const workerArgs = args.filter((item) => item !== '--headless');
        return await runHeadless(workerArgs);
    }

    let terminalKit;
    try {
        terminalKit = await import('terminal-kit');
    } catch (error) {
        process.stderr.write(`ai-decompose: terminal-kit is not available: ${error?.message ?? error}\n`);
        return 1;
    }
    const kit = terminalKit.default ?? terminalKit;
    const term = kit.terminal;

    // The CLI of the decomposer has one command: the run itself. The task of the run is the
    // prompt, and the images are the inputs of it.
    const command = 'decompose';
    const task = [parsed.prompt, ...parsed.positionals].filter(Boolean).join(' ');
    const app = createTuiApp({
        term,
        args,
        command,
        task,
        cwd: process.cwd(),
        env: process.env,
        ascii: Boolean(parsed.flags.ascii),
    });
    const result = await app.run();
    for (const item of result.outputs ?? []) {
        process.stdout.write(`${item.line}\n`);
    }
    if (result.code !== 0) {
        process.stderr.write(`ai-decompose: the worker exited with code ${result.code}\n`);
    }
    return result.code;
}
