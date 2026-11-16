/**
 * @file src/agent/cli-family.js
 * @module agent/cli-family
 * @purpose The CLIs of the house — the family `ai-*` — and the manual a role reads before it
 *          calls one of them.
 *
 *   The tools of the house are narrow on purpose: a crop, a split, a projection, a cut of the
 *   corners. But a picture is a wide thing, and the neighbour CLIs are wide too: `ai-image`
 *   makes and cuts pictures, `ai-measure` measures them, and both know flags and commands
 *   that no narrow tool of this package covers. A role that needs one of them has nowhere to
 *   go — the package has no bridge to the sibling CLIs.
 *
 *   So the family gets a free door: the tool `ai_cli` calls any CLI of the family with the
 *   arguments the role names, and the tool `ai_cli_help` gives the manual. The rules of the
 *   house stay the rules of every tool: the command is started without a shell, it runs in
 *   the working directory of the run, every path of it stays inside that directory, the file
 *   that is written lands in a directory the stage opened for writing, and a command that
 *   does not finish on its own is refused.
 *
 *   The rule of the house about the flags is one line: ask the CLI. Every CLI of the family
 *   answers `--help` with the whole table of its commands and its flags, and the help is a
 *   local text — it calls no model and costs nothing.
 *
 * @depends node:path, node:fs/promises, node:child_process, node:url
 * @usedBy agent/tools (ai_cli, ai_cli_help)
 * @exports FAMILY_CLIS, FAMILY_DOC_TOPICS, FAMILY_ROOT, FAMILY_TIMEOUT_MS, familyNames,
 *          familyDoc, familyCandidates, resolveFamilyCli, runFamilyCli, familyPathArgs,
 *          familyOutputArg
 * @ai.tags cli, family, tools
 * @ai.hint keep
 * @changed 2026-11-16 The family gets a free door: any CLI of the house with any flag of it,
 *                       and the manual that tells which flags there are.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The root of this package: the sibling packages are looked up next to it. */
export const FAMILY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** How long a call of the family may run when the role does not say. */
export const FAMILY_TIMEOUT_MS = 120_000;

/** The ceiling of the timeout of a call of the family. */
const MAX_TIMEOUT_MS = 600_000;

/**
 * Quote an argument for the command line of Windows.
 *
 * The shell of Windows reads the command line as one string, so the arguments with spaces
 * or with a quote of their own have to be quoted for it.
 * @param {string} value
 * @returns {string}
 * @ai.hint pure
 */
function quoteWindowsArg(value) {
    const text = String(value ?? '');
    if (!text) return '""';
    if (!/[\s"&|<>^(),;]/.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Kill a program and everything it started.
 *
 * On Windows the children survive the parent, so the tree is killed with `taskkill`: a
 * command that was started by mistake does not hold the machine.
 * @param {object} child the process of the program
 * @returns {void}
 * @ai.hint io
 */
function killTree(child) {
    const pid = child?.pid;
    if (process.platform === 'win32' && pid) {
        try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true }).unref?.();
        } catch { /* the process is gone already */ }
        return;
    }
    try {
        child?.kill?.();
    } catch { /* the process is gone already */ }
}

/**
 * The CLIs of the house.
 *
 * `dirs` are the places where the checkout of the package may live, relative to the root of
 * this package; `script` is the entry of the CLI inside that checkout. A `.js` entry is run
 * with the same Node that runs this CLI; anything else is an executable.
 *
 * @type {Readonly<Record<string, {command: string, env: string, package: string|null,
 *   dirs: string[], script: string, summary: string}>>}
 * @exports
 */
export const FAMILY_CLIS = Object.freeze({
    'ai': {
        command: 'ai',
        env: 'AI_BIN',
        package: '@u2ai/universal-ai',
        dirs: ['..', '..'],
        script: path.join('bin', 'ai.js'),
        summary: 'The umbrella of the house: ask, chat, run, gen, image, decompose, serve, mcp.',
    },
    'ai-webdev': {
        command: 'ai-webdev',
        env: 'AI_WEBDEV_BIN',
        package: '@u2ai/webdev',
        dirs: ['u2ai-webdev', '..', 'u2ai-webdev', 'submodules', 'u2ai-webdev'],
        script: path.join('bin', 'ai-webdev.js'),
        summary: 'The web project: the plan, the stages, the roles.',
    },
    'ai-decompose': {
        command: 'ai-decompose',
        env: 'AI_DECOMPOSE_BIN',
        package: '@u2ai/decomposer',
        dirs: ['u2ai-decomposer', '..', 'u2ai-decomposer', 'submodules', 'u2ai-decomposer'],
        script: path.join('bin', 'ai-decompose.js'),
        summary: 'This CLI: splits a reference into screens and fragments.',
    },
    'ai-measure': {
        command: 'ai-measure',
        env: 'AI_MEASURE_BIN',
        package: '@u2ai/measurer',
        dirs: ['u2ai-measurer', '..', 'u2ai-measurer', 'submodules', 'u2ai-measurer'],
        script: path.join('bin', 'ai-measure.js'),
        summary: 'Measures a reference: the frames, the gaps, the sizes, the colours.',
    },
    'ai-image': {
        command: 'ai-image',
        env: 'AI_IMAGE_BIN',
        package: '@u2ai/images',
        dirs: ['u2ai-images', '..', 'u2ai-images', 'submodules', 'u2ai-images'],
        script: path.join('bin', 'ai-image.js'),
        summary: 'Makes the pictures of the project and cuts them.',
    },
});

/** The topics of the manual of the family. */
export const FAMILY_DOC_TOPICS = Object.freeze(['family', 'flags', 'commands', 'all']);

/**
 * The names of the CLIs of the house.
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function familyNames() {
    return Object.keys(FAMILY_CLIS);
}

/**
 * The files that may hold a CLI of the family, in the order they are tried.
 * @param {string} name the name of the CLI
 * @param {{ root?: string, env?: object }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function familyCandidates(name, { root = FAMILY_ROOT, env = process.env } = {}) {
    const spec = FAMILY_CLIS[String(name ?? '').trim()];
    if (!spec) return [];
    const candidates = [];
    if (env?.[spec.env]) candidates.push(path.resolve(String(env[spec.env])));
    for (const dir of spec.dirs ?? []) candidates.push(path.join(root, dir, spec.script));
    if (spec.package) {
        // The installed package: a sibling of this one or a dependency of it.
        candidates.push(path.join(root, '..', ...spec.package.split('/'), spec.script));
        candidates.push(path.join(root, 'node_modules', ...spec.package.split('/'), spec.script));
    }
    return candidates;
}

/**
 * The executable of a CLI of the family in the PATH.
 * @param {string} command the name of the program
 * @param {object} env
 * @returns {Promise<{ command: string, args: string[], shell?: boolean }|null>}
 * @ai.hint io
 */
async function findOnPath(command, env) {
    const names = process.platform === 'win32'
        ? [`${command}.cmd`, `${command}.exe`, command]
        : [command];
    for (const dir of String(env?.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const candidate of names) {
            const full = path.join(dir, candidate);
            if (!await stat(full).then(() => true).catch(() => false)) continue;
            if (process.platform === 'win32' && candidate.endsWith('.cmd')) {
                return { command: full, args: [], shell: true };
            }
            return { command: full, args: [] };
        }
    }
    return null;
}

/**
 * Find the CLI of the family to call.
 *
 * A `.js` entry is run with the same Node that runs this CLI; a shim of Windows is a batch
 * file, and a batch file is started through the shell of the system.
 * @param {string} name the name of the CLI
 * @param {{ root?: string, env?: object }} [options]
 * @returns {Promise<{ command: string, args: string[], shell?: boolean }|null>} null when it is not installed
 * @exports
 * @ai.hint io
 */
export async function resolveFamilyCli(name, { root = FAMILY_ROOT, env = process.env } = {}) {
    const spec = FAMILY_CLIS[String(name ?? '').trim()];
    if (!spec) return null;
    for (const candidate of familyCandidates(name, { root, env })) {
        if (!await stat(candidate).then(() => true).catch(() => false)) continue;
        if (candidate.endsWith('.js')) return { command: process.execPath, args: [candidate] };
        if (candidate.endsWith('.cmd') || candidate.endsWith('.bat')) return { command: candidate, args: [], shell: true };
        return { command: candidate, args: [] };
    }
    return await findOnPath(spec.command, env);
}

/**
 * Run a CLI of the family and collect its answer.
 *
 * The program is started without a shell, so nothing in the arguments can become a second
 * command. The program does not wait for the input: a CLI that reads a question without
 * asking one would hold the run until the timeout and would bring nothing.
 * @param {{ found: {command: string, args?: string[], shell?: boolean}, args?: string[],
 *   cwd?: string, env?: object, timeoutMs?: number }} request
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function runFamilyCli({ found, args = [], cwd = process.cwd(), env = process.env, timeoutMs = FAMILY_TIMEOUT_MS } = {}) {
    if (!found?.command) return { code: null, stdout: '', stderr: 'The CLI is not installed.', timedOut: false };
    const list = (Array.isArray(args) ? args : []).map(String);
    const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, MAX_TIMEOUT_MS)
        : FAMILY_TIMEOUT_MS;
    return await new Promise((resolve) => {
        const full = [...(found.args ?? []), ...list];
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        // A shim is a batch file: it is started through the shell of the system, and the
        // arguments are quoted for that shell.
        const child = found.shell
            ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', [found.command, ...full].map(quoteWindowsArg).join(' ')], {
                cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: true,
            })
            : spawn(found.command, full, { cwd, env, shell: false, windowsHide: true });
        child.stdin?.end?.();
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, limit);
        timer.unref?.();
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? null, stdout, stderr, timedOut });
        });
    });
}

/** The flags whose value is a file of the run. */
const PATH_FLAGS = new Set([
    '-i', '--image', '--file', '--input', '--reference', '--out-dir', '--dir',
]);

/** The flags whose value is where the result is written. */
const OUTPUT_FLAGS = new Set(['-o', '--out', '--output']);

/** The extensions that make an argument a file of the run. */
const FILE_EXTENSION = /\.(?:png|jpe?g|webp|gif|svg|avif|bmp|ico|json|jsonl|css|scss|sass|less|html?|jsx?|tsx?|md|txt|ya?ml|toml|xml|csv|woff2?|ttf|eot|zip|tar|gz)$/i;

/**
 * The arguments of a command line that name a file of the run.
 *
 * A file is named in three ways: the value of a flag that takes a path, an argument with a
 * separator in it, and an argument with the extension of a file. The last one is a guess,
 * and a guess is enough: the name is checked against the working directory, and a wrong
 * guess only means that the check was not made.
 * @param {string[]} args the arguments of the command line
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function familyPathArgs(args = []) {
    const list = Array.isArray(args) ? args.map(String) : [];
    const out = [];
    let flag = null;
    for (const arg of list) {
        if (flag) {
            if (PATH_FLAGS.has(flag)) out.push(arg);
            flag = null;
            continue;
        }
        if (arg.startsWith('-')) {
            // A flag with a value in the same word: `--out=build`.
            const [name, value] = arg.split('=', 2);
            if (value !== undefined && PATH_FLAGS.has(name)) out.push(value);
            else flag = name;
            continue;
        }
        if (/[\\/]/.test(arg) || FILE_EXTENSION.test(arg)) out.push(arg);
    }
    return out;
}

/**
 * The place where the command writes its result, if it names one.
 *
 * The value of `-o`, `--out` or `--output` is where the files of the run land, so it has to
 * be a directory the stage opened for writing.
 * @param {string[]} args the arguments of the command line
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function familyOutputArg(args = []) {
    const list = Array.isArray(args) ? args.map(String) : [];
    for (let index = 0; index < list.length; index += 1) {
        const arg = list[index];
        if (arg.startsWith('-')) {
            const [name, value] = arg.split('=', 2);
            if (OUTPUT_FLAGS.has(name)) {
                if (value !== undefined) return value;
                const next = list[index + 1] ?? '';
                return next.startsWith('-') ? null : next;
            }
        }
    }
    return null;
}

const FAMILY = `The CLIs of the house are the programs of the family \`ai-*\` (the packages are \`@u2ai/*\`):

  ai              the umbrella: ask, chat, run, gen, image, decompose, component, serve, mcp
  ai-webdev       the web project: the plan, the stages, the roles
  ai-decompose    this CLI: splits a reference into screens and fragments
  ai-measure      measures a reference: the frames, the gaps, the sizes, the colours
  ai-image        makes the pictures of the project and cuts them

The rule of the house about the flags is one line: ask the CLI.

  Every CLI of the family answers \`--help\` with the whole table of its commands and its
  flags, and \`--version\` with its version. The help is a local text: it calls no model and
  costs nothing. Ask for it before the first call of a CLI, and again when a flag was
  refused — the answer of the CLI is always right for the version that is installed.

  A call is exact: the arguments go to the program one by one, without a shell. A flag with
  a value is two arguments: ["--out", "build"], never one string.

Where the binary is looked for:
  the environment variable of the CLI (AI_BIN, AI_WEBDEV_BIN, AI_DECOMPOSE_BIN,
  AI_MEASURE_BIN, AI_IMAGE_BIN), then the checkout of the sibling package, then
  node_modules, then the PATH.

The rules of the house for a free call:
  - the command is started without a shell, so the arguments are exact;
  - it runs in the working directory of the run;
  - every path of the command stays inside the working directory;
  - the file that is written lands in a directory the stage opened for writing;
  - a command that does not finish on its own is refused (a server, a watcher);
  - the config of the CLI may be named: the config of the home lives outside the working
    directory and is always allowed.`;

const FLAGS = `The flags of the family:

  -h, --help              the whole help of the CLI
      --version           the version of the package
  -i, --image <path>      a picture of the task; may be given many times
  -o, --out <dir|file>    where the result is written
  -c, --config <path>     the config file of the CLI
  -m, --model <id>        the model of the run
      --effort <level>    the ceiling of the effort: low, medium, high, xhigh
      --dry-run           show the plan and stop
      --json              the answer as json
      --verbose           more detail

  The short \`-v\` means different things in different CLIs: the version in \`ai-measure\` and
  \`ai-webdev\`, the verbose log in \`ai-decompose\`, \`ai-image\` and \`ai\`. Use the long names.

The flags of every CLI:

  ai              --image, --file, --input, --tools, --no-tools, --approve, --cwd,
                   --max-turns, --budget-usd, --role, --decompose, --measure, --subrefs,
                   --stages, --advanced, --json, --quiet, --verbose
  ai-webdev       --route, --stop-after, --resume, --id, --pace, --quality, --fidelity,
                   --creativity, --platform, --kind, --frontend-framework,
                   --frontend-markup-language, --frontend-style-language, --icon-set,
                   --input, --image, --extract, --approve, --role, --model, --effort,
                   --summary, --context, --detail, --json, --quiet, --ascii, --config
  ai-decompose    --image, --out, --prompt, --stages, --stop-after, --advanced, --dry-run,
                   --image-model, --model, --effort, --batch, --batch-fetch, --verbose
  ai-measure      --image, --out, --stages, --task, --model, --effort, --colors, --x, --y,
                   --width, --height, --output, --rows, --cols, --out-dir, --dry-run,
                   --verbose
  ai-image        --out, --model, --image-model, --effort, --summary, --quality, --purpose,
                   --image, --reference, --size, --width, --height, --mode, --alpha-mode,
                   --subject, --attempts, --rows, --cols, --fuzz, --trim, --color, --dry-run,
                   --batch, --batch-fetch, --verbose

  The table above is a summary, not the truth: \`ai --help\` is the truth.`;

const COMMANDS = `The commands of every CLI:

  ai              ask (the default one), chat, run, gen, image, decompose, component, install,
                   resume, cancel, jobs, memory, agents, models, config, map, complete, mcp,
                   decide, moderate, channels, telegram, serve
  ai-webdev       run, plan, stages, component, install, config, jobs, memory, skills
  ai-decompose    none: the flags do the work, and --stages names the stages of the run
  ai-measure      measure, design, palette, crop, split, tokens, docs, config, skills
  ai-image        generate, edit, vectorize, decorate, crop, pad, fit, resize, trim, split,
                   alpha, background, compare, info, purpose, process, config

How a call looks:

  ai_cli with cli="ai-image" and args=["--help"]
  ai_cli with cli="ai-image" and args=["info", "screens/01-home.png"]
  ai_cli with cli="ai-measure" and args=["measure", "landing.png", "--out", "measurements"]
  ai_cli with cli="ai-decompose" and args=["--help"] — the flags of the decomposer, not of the bridge`;

/**
 * The manual of the family, by topic.
 *
 * A topic that is not known is not an error: the whole manual is returned, because a role
 * that asked for the wrong word still needs the manual.
 * @param {string} topic the name of the topic
 * @returns {string} the text of the manual
 * @exports
 * @ai.hint pure
 */
export function familyDoc(topic = 'all') {
    const key = String(topic ?? '').trim().toLowerCase();
    if (!key || key === 'all') return [FAMILY, FLAGS, COMMANDS].join('\n\n');
    if (key === 'family') return FAMILY;
    if (key === 'flags') return FLAGS;
    if (key === 'commands') return COMMANDS;
    return [FAMILY, FLAGS, COMMANDS].join('\n\n');
}
