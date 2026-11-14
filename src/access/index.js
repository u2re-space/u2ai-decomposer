/**
 * @file src/access/index.js
 * @module access
 * @purpose The access of a run: the files and the commands under one root.
 *
 *   The access is the only door between the model and the machine. It has two halves —
 *   the files and the commands — and both of them work through a backend. The default
 *   backend is the disk and the processes of Node.js; another one may be put in its place
 *   without touching a line of the rules.
 *
 *   ```js
 *   const access = createAccess({ root: process.cwd() });
 *   await access.fs.writeText('notes/todo.md', '# todo');
 *   const answer = await access.exec.run('node', ['--version']);
 *   ```
 *
 * @depends node:path, access/paths, access/fs, access/exec, access/native
 * @usedBy access/index, agent/paths
 * @exports createAccess, ACCESS_LIMITS, EXEC_LIMITS
 * @ai.tags access, filesystem, exec
 * @ai.hint io
 */

import path from 'node:path';
import { createFileSystem, ACCESS_LIMITS } from './fs.js';
import { createCommandRunner, EXEC_LIMITS } from './exec.js';
import { createNativeFileSystem, createNativeExecutor } from './native.js';

export { ACCESS_LIMITS, EXEC_LIMITS };
export { resolveInside, isInside, toPosix, NOISY_DIRS } from './paths.js';

/**
 * Create the access of one root.
 *
 * @param {{ root?: string, fs?: object|null, exec?: object|null, env?: object,
 *           limits?: object, timeoutMs?: number, messages?: object }} [options]
 * @returns {{ root: string, fs: object, exec: object }}
 * @exports
 * @ai.hint io
 */
export function createAccess({
    root = process.cwd(),
    fs = null,
    exec = null,
    env = process.env,
    limits = {},
    timeoutMs = EXEC_LIMITS.timeoutMs,
    messages = {},
} = {}) {
    const base = path.resolve(String(root ?? process.cwd()));
    const fileBackend = fs ?? createNativeFileSystem();
    const execBackend = exec ?? createNativeExecutor();
    return {
        root: base,
        fs: createFileSystem({ root: base, backend: fileBackend, limits, messages }),
        exec: createCommandRunner({
            root: base,
            backend: execBackend,
            env,
            timeoutMs,
            messages,
            probe: {
                lstat: typeof fileBackend.lstat === 'function' ? fileBackend.lstat : null,
                realpath: typeof fileBackend.realpath === 'function' ? fileBackend.realpath : null,
            },
        }),
    };
}
