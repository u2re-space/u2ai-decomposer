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
import { loadConfig } from './config.js';
import { createClient } from './openai/client.js';
import { createRenderer, createPlainRenderer, detectMode } from './cli/renderer.js';
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
        positionals: parsed.positionals,
    };
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

    const opts = parseArgv(argv);
    const config = await loadConfig({ configPath: opts.configPath, cwd: process.cwd() });
    const isTTY = detectMode() === 'tty';
    const renderer = isTTY
        ? createRenderer({ verbose: opts.verbose })
        : createPlainRenderer({ verbose: opts.verbose });
    const client = await createClient({ config, signal: null });

    try {
        await runPipeline({
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
        return 0;
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.error('Aborted.');
            return 130;
        }
        console.error(`Error: ${error.message || error}`);
        return 1;
    }
}