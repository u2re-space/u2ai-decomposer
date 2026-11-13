/**
 * @file src/agent/skills.js
 * @purpose Skills loader: find and apply project-specific skill files.
 * @exports loadSkills
 * @ai.hint keep
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Load skills from ~/.ai-decompose/skills/ directory.
 * @param {string} [home]
 * @returns {Promise<Array<{ name: string, content: string }>>}
 */
export async function loadSkills(home = null) {
    const dir = home ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.ai-decompose', 'skills');
    try {
        const entries = await readdir(dir);
        const skills = [];
        for (const entry of entries) {
            if (!entry.endsWith('.md')) continue;
            const content = await readFile(path.join(dir, entry), 'utf-8');
            skills.push({ name: entry.replace('.md', ''), content });
        }
        return skills;
    } catch {
        return [];
    }
}