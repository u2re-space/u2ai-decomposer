/**
 * @file test/access.test.js
 * @module test/access
 * @purpose The access layer: the rules of the paths, the files over a backend, and the
 *          commands over a backend.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveInside, isInside, isProtectedFileName, isForbiddenDirName, toPosix } from '../src/access/paths.js';
import { createAccess } from '../src/access/index.js';
import { createMemoryBackend } from '../src/access/memory.js';
import { createNativeBackend } from '../src/access/native.js';

/**
 * A fresh directory for one test.
 * @returns {Promise<string>}
 */
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'ai-decompose-access-'));
}

test('the rules of the paths: the escape, the secrets and the read-only directories', async () => {
  const root = await tempDir();
  try {
    const inside = await resolveInside(root, 'src/index.js');
    assert.equal(inside.abs, path.join(root, 'src', 'index.js'));
    assert.equal(inside.rel, 'src/index.js');

    await assert.rejects(() => resolveInside(root, '../outside.txt'), /outside the working directory/);
    await assert.rejects(() => resolveInside(root, '.env'), /the secret is not accessible/);
    await assert.rejects(() => resolveInside(root, '.ssh/id_rsa'), /The access is denied/);
    await assert.rejects(() => resolveInside(root, 'node_modules/pkg/index.js', { forWrite: true }), /The write into node_modules is denied/);

    assert.equal(isInside(root, path.join(root, 'a', 'b')), true);
    assert.equal(isInside(root, path.resolve(root, '..')), false);
    assert.equal(isProtectedFileName('secrets.yaml'), true);
    assert.equal(isForbiddenDirName('.aws'), true);
    assert.equal(toPosix(path.join('a', 'b')), 'a/b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the symbolic link out of the root is refused', async () => {
  const root = await tempDir();
  const outside = await tempDir();
  try {
    await writeFile(path.join(outside, 'data.txt'), 'no', 'utf8');
    await symlink(outside, path.join(root, 'link'), 'dir');
    await assert.rejects(() => resolveInside(root, 'link/data.txt'), /symbolic link leaves the working directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the files over the backend in the memory: the write, the read, the list and the delete', async () => {
  const backend = createMemoryBackend();
  const access = createAccess({ root: '/work', fs: backend.fs, exec: backend.exec });

  const written = await access.fs.writeText('notes/todo.md', '# todo\n- one\n');
  assert.equal(written.path, 'notes/todo.md');
  assert.equal(written.created, true);

  const read = await access.fs.readText('notes/todo.md');
  assert.equal(read.text, '# todo\n- one\n');
  assert.equal(read.bytes, 13);
  assert.equal(read.truncated, false);

  const list = await access.fs.list('.');
  assert.deepEqual(list.entries.map((entry) => entry.path), ['notes']);
  const deep = await access.fs.list('.', { depth: 3 });
  assert.deepEqual(deep.entries.map((entry) => entry.path), ['notes', 'notes/todo.md']);

  const state = await access.fs.stat('notes/todo.md');
  assert.equal(state.exists, true);
  assert.equal(state.type, 'file');
  assert.equal(await access.fs.exists('notes/none.md'), false);

  const removed = await access.fs.remove('notes/todo.md');
  assert.equal(removed.removed, true);
  assert.equal(await access.fs.exists('notes/todo.md'), false);
});

test('the files over the backend in the memory: the search and the replace', async () => {
  const backend = createMemoryBackend();
  const access = createAccess({ root: '/work', fs: backend.fs, exec: backend.exec });

  await access.fs.writeText('src/app.js', 'const answer = 42;\nconst other = 42;\n');
  await access.fs.writeText('src/other.js', 'const third = 1;\n');

  const found = await access.fs.search({ query: 'answer' });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].path, 'src/app.js');
  assert.equal(found.matches[0].line, 1);

  const replaced = await access.fs.replace('src/app.js', '42', '43', { all: true });
  assert.equal(replaced.changed, true);
  assert.equal(replaced.count, 2);
  assert.equal((await access.fs.readText('src/app.js')).text, 'const answer = 43;\nconst other = 43;\n');

  const missing = await access.fs.replace('src/app.js', 'nothing', 'x');
  assert.equal(missing.changed, false);
});

test('the facade of the files refuses the paths out of the root and the secrets', async () => {
  const backend = createMemoryBackend();
  const access = createAccess({ root: '/work', fs: backend.fs, exec: backend.exec });
  await assert.rejects(() => access.fs.readText('../outside.txt'), /outside the working directory/);
  await assert.rejects(() => access.fs.writeText('.env', 'SECRET=1'), /the secret is not accessible/);
});

test('the commands over the backend in the memory: the call is recorded', async () => {
  const backend = createMemoryBackend({ answers: { node: { code: 0, stdout: 'v26.0.0\n' } } });
  const access = createAccess({ root: '/work', fs: backend.fs, exec: backend.exec });

  const answer = await access.exec.run('node', ['--version']);
  assert.equal(answer.ok, true);
  assert.equal(answer.code, 0);
  assert.equal(answer.stdout, 'v26.0.0\n');
  assert.equal(backend.exec.calls.length, 1);
  assert.deepEqual(backend.exec.calls[0].args, ['--version']);

  await assert.rejects(() => access.exec.run('node', ['--version'], { cwd: '../elsewhere' }), /outside the working directory/);
  await assert.rejects(() => access.exec.run(''), /command is missing/);
});

test('the commands over the native backend: the program runs', async () => {
  const root = await tempDir();
  try {
    const backend = createNativeBackend();
    const access = createAccess({ root, fs: backend.fs, exec: backend.exec });
    const answer = await access.exec.run(process.execPath, ['--version']);
    assert.equal(answer.ok, true);
    assert.match(answer.stdout, /v\d+\.\d+\.\d+/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the files over the native backend: the write and the read on the disk', async () => {
  const root = await tempDir();
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf8');
    const access = createAccess({ root });
    const read = await access.fs.readText('src/index.js');
    assert.equal(read.text, 'export const answer = 42;\n');
    const list = await access.fs.list('src');
    assert.deepEqual(list.entries.map((entry) => entry.path), ['src/index.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
