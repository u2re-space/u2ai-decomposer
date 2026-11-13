/**
 * @file src/agent/skills.js
 * @module agent/skills
 * @purpose Read-only skill packs: the markdown a user drops next to the config to teach a role
 *          something the model does not know.
 *
 *   A skill pack is a set of markdown files in one directory. A file named after a role
 *   (`rectifier.md`) belongs to that role alone; the other files are shared by every role. The
 *   text is appended to the instructions of the role, so it is part of the system prompt and not
 *   something the model can be talked out of.
 *
 *   The packs are read, never written: the decomposer has no business changing the files a user
 *   keeps for this purpose.
 *
 * @depends node:fs/promises, node:path
 * @usedBy shared/pipeline
 * @exports loadSkills, skillsForRole
 * @ai.tags skills, prompts
 * @ai.hint io
 */

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

/**
 * The default directory of the skill packs.
 * @param {object} [env]
 * @returns {string}
 * @ai.hint pure
 */
export function defaultSkillsDir(env = process.env) {
    const home = env.AI_DECOMPOSE_HOME || env.HOME || env.USERPROFILE || '';
    return path.join(home, '.ai-decompose', 'skills');
}

/**
 * Load the skill packs of one directory.
 *
 * @param {{ dir?: string|null, role?: string|null, env?: object }} [options]
 *   `role` narrows the list to the pack of that role plus the shared packs.
 * @returns {Promise<Array<{ name: string, content: string }>>}
 * @exports
 * @ai.hint io
 */
export async function loadSkills({ dir = null, role = null, env = process.env } = {}) {
    const root = dir ? path.resolve(dir) : defaultSkillsDir(env);
    let entries = [];
    try {
        entries = await readdir(root);
    } catch {
        return [];
    }
    const packs = [];
    for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const name = entry.slice(0, -3);
        if (role && name !== role && name !== 'shared' && name !== '_shared') continue;
        const content = await readFile(path.join(root, entry), 'utf-8').catch(() => null);
        if (content === null) continue;
        packs.push({ name, content });
    }
    return packs;
}

/**
 * The text of the skill packs that belong to one role, ready to be appended to its instructions.
 *
 * @param {{ dir?: string|null, role?: string|null, env?: object }} [options]
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function skillsForRole(options = {}) {
    const packs = await loadSkills(options);
    if (!packs.length) return '';
    return packs
        .map((pack) => `## Skill pack: ${pack.name}\n${pack.content.trim()}`)
        .join('\n\n');
}
