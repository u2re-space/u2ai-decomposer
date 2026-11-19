#!/usr/bin/env node
/**
 * @file bin/ai-decompose-worker.js
 * @module bin/ai-decompose-worker
 * @purpose Process entry of the internal worker. It owns the CLI and talks to a shell over IPC.
 * @depends cli/worker
 * @usedBy ai-decompose shell and package bin
 * @ai.tags cli, worker
 * @ai.hint io
 */
import { mainWorker } from '../src/cli/worker.js';

// A crash that happened outside the command keeps its own exit code: the command may
// have returned 0 before the process fell over.
process.exitCode = (await mainWorker(process.argv.slice(2))) || process.exitCode || 0;
