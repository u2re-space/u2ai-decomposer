/**
 * @file src/cli.js
 * @module cli
 * @purpose Parse argv, dispatch pipeline stages, and map failures to process exit codes.
 * @depends node:path, node:util, node:fs/promises, node:url, core/config, openai/client, shared/pipeline, cli/help, cli/renderer
 * @exports HELP, parseArgv, main
 * @ai.tags cli, dispatch
 * @ai.hint keep
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createClient, resolveBackends } from './openai/client.js';
import { createJournal } from './openai/journal.js';
import { BATCH_SUBMITTED } from './openai/batch.js';
import { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
import { checkNodeVersion } from './cli/compatibility.js';
import { HELP } from './help.js';
import { runPipeline } from './shared/pipeline.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/**
 * Strip --detach/--background flags that the CLI accepts but the pipeline stage does not use.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripDetach(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--detach' || argv[i] === '--background') continue;
        if (argv[i] === '--detach=' || argv[i] === '--background=') { i++; continue; }
        out.push(argv[i]);
    }
    return out;
}

/**
 * Minimal argv parser for ai-decompose: image input, output dir, stages, config, model.
 * @param {string[]} argv
 * @returns {{ image: string[], out: string, config: string|null, stages: string[], model: string|null, effort: string|null, imageModel: string|null, configPath: string|null, verbose: boolean }}
 */
export function parseArgv(argv) {
    const parsed = parseArgs({
        options: {
            image:    { type: 'string', multiple: true, short: 'i' },
            out:      { type: 'string', short: 'o', default: '.' },
            config:   { type: 'string', short: 'c' },
            stages:   { type: 'string', multiple: true },
            model:    { type: 'string', short: 'm' },
            effort:   { type: 'string' },
            'image-model': { type: 'string' },
            verbose:  { type: 'boolean', default: false },
            'no-verbose': { type: 'boolean', default: false },
            help:     { type: 'boolean', default: false },
            version:  { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            'advanced': { type: 'boolean', default: false },
            'stop-after': { type: 'string' },
            'batch': { type: 'boolean', default: false },
            'batch-fetch': { type: 'boolean', default: false },
        },
        strict: false,
        allowPositionals: true,
        args: argv,
    });

    const image = parsed.values.image ?? [];
    const stages = (parsed.values.stages ?? ['extend', 'decompose', 'rectify', 'reconstruct', 'overlap', 'resolve'])
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim())
        .filter(Boolean);
    const verbose = parsed.values.verbose === true && parsed.values['no-verbose'] !== true;

    return {
        image,
        out: parsed.values.out,
        config: parsed.values.config ?? null,
        stages,
        model: parsed.values.model ?? null,
        effort: parsed.values.effort ?? null,
        imageModel: parsed.values['image-model'] ?? null,
        configPath: parsed.values.config ?? null,
        verbose,
        help: parsed.values.help ?? false,
        version: parsed.values.version ?? false,
        dryRun: parsed.values['dry-run'] ?? false,
        advanced: parsed.values['advanced'] ?? false,
        stopAfter: parsed.values['stop-after'] ?? null,
        batch: parsed.values.batch === true,
        batchFetch: parsed.values['batch-fetch'] === true,
        positionals: parsed.positionals,
    };
}

/**
 * Is there a key to call the API with?
 *
 * A local server may work without one; a remote host may not, and the difference is worth a
 * sentence before the run starts rather than a 401 in the middle of it.
 * @param {object} config the loaded configuration
 * @param {object} [env] the environment the keys are read from
 * @returns {boolean}
 * @ai.hint pure
 */
export function apiKeyAvailable(config, env = process.env) {
    const chain = resolveBackends(config, { kind: 'text', env });
    if (chain.some((item) => item.apiKey)) return true;
    // A server on this machine is often open.
    return chain.length > 0 && chain.every((item) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(item.baseURL));
}

/**
 * Main entry point: load config, create client, run the pipeline.
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
    // Handle --help / --version before config load.
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(HELP);
        return 0;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
        console.log(pkg.version);
        return 0;
    }

    const runtime = checkNodeVersion();
    if (!runtime.ok) {
        console.error(`Node.js ${runtime.required} is required, this is ${runtime.version}.`);
        return 1;
    }

    const opts = parseArgv(argv);
    let config;
    try {
        config = await loadConfig({ configPath: opts.configPath, cwd: process.cwd() });
    } catch (error) {
        console.error(error?.message ?? String(error));
        return 1;
    }
    if (!opts.dryRun && !apiKeyAvailable(config)) {
        console.error('No API key: set AI_DECOMPOSE_API_KEY, put "apiKey" into ~/.ai-decompose/config.json, '
            + 'or give a backend the name of an environment variable that holds the key.');
        return 1;
    }
    const isTTY = detectMode() === 'tty';
    const renderer = isTTY
        ? createRenderer({ verbose: opts.verbose })
        : createPlainRenderer({ verbose: opts.verbose });

    // The batch route is two-phase: the first run submits the requests of a parallel round and
    // stops, the second one takes the answers and goes on. The journal is what the two phases
    // share: the answer of a request is found by the hash of the request.
    const batchMode = opts.batchFetch
        ? 'fetch'
        : (opts.batch || config.batch?.enabled === true ? 'submit' : 'off');
    const journal = batchMode === 'off'
        ? null
        : createJournal({
            dir: path.resolve(process.cwd(), opts.out, config.batch?.journalDir ?? 'decomposition/.batch'),
        });
    if (journal) await journal.init().catch(() => {});

    // The events of the transport go to the reader too: a retry or a host that fell out
    // is something the user has to know, not something to hide in a log.
    const client = await createClient({
        config,
        signal: null,
        onEvent: (event) => renderer.event(event),
        batch: journal ? {
            mode: batchMode,
            journal,
            collectMs: config.batch?.collectMs,
            pollMs: config.batch?.pollMs,
            waitMs: config.batch?.waitMs,
            maxRequests: config.batch?.maxRequests,
            window: config.batch?.window,
            endpoint: config.batch?.endpoint,
        } : null,
    });

    if (journal && !client.batches.hosts().length) {
        console.error('No host serves the batch route: put "supports": { "batch": true } into a backend '
            + 'of the config, and give that backend a key.');
        return 1;
    }

    // The second phase: the answers of the submitted batches go into the journal, and the run
    // goes on with them.
    if (journal && batchMode === 'fetch') {
        const fetched = await client.batches.fetch();
        if (!fetched.ready) {
            console.error('The batch is not ready yet. Run the same command with --batch-fetch again later.');
            return 3;
        }
    }

    try {
        const result = await runPipeline({
            root: process.cwd(),
            images: opts.image,
            outDir: opts.out,
            stages: opts.stages,
            config,
            client,
            model: opts.model,
            effort: opts.effort,
            imageModel: opts.imageModel,
            advanced: opts.advanced,
            stopAfter: opts.stopAfter,
            dryRun: opts.dryRun,
            notify: (event) => renderer.event(event),
        });
        // A stage that threw leaves the run unfinished: the exit code says so, and the pipeline
        // still leaves behind everything that did work.
        renderer.summary?.({
            output: result?.output ?? null,
            outputPath: result?.outputPath ?? null,
            warnings: result?.warnings ?? [],
        });
        return result?.failed ? 1 : 0;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.error('Aborted.');
            return 130;
        }
        // The batch is out: the answers are not here yet, and the run waits for them.
        if (error?.code === BATCH_SUBMITTED) {
            const id = error?.details?.batchId ?? '';
            console.error(`The batch ${id ? `${id} ` : ''}was submitted — the answers are not here yet. `
                + 'Run the same command with --batch-fetch.');
            return 2;
        }
        console.error(`Error: ${error.message || error}`);
        return 1;
    }
}