/**
 * @file src/roles/cli-note.js
 * @module roles/cli-note
 * @purpose The rule that keeps a role from guessing the flags of a CLI of the house.
 *
 *   The CLIs of the house — `ai`, `ai-webdev`, `ai-decompose`, `ai-measure`, `ai-image` —
 *   carry the table of their commands and their flags in themselves: `--help` prints it. A
 *   role that guesses a flag pays for the guess with a failed call and a wasted turn, and
 *   the help of a CLI is a local text: it calls no model and costs nothing.
 *
 *   The neighbour `ai-image` is the one the roles of the pictures meet first: it makes a
 *   picture, cuts it, trims it, changes its size, tells what is inside it.
 *
 * @depends none
 * @usedBy roles/decomposer, roles/rectifier, roles/restorer, roles/overlap, roles/extender
 * @exports FAMILY_CLI_NOTE
 * @ai.tags roles, cli, family
 * @ai.hint pure
 */

/**
 * The rule about the CLIs of the house, written for the instructions of a role.
 * @type {string}
 * @exports
 * @ai.hint pure
 */
export const FAMILY_CLI_NOTE = `The CLIs of the house are yours too. The neighbour \`ai-image\` makes and cuts pictures, \`ai-measure\`
measures them, and every CLI of the family answers \`--help\` with the whole table of its commands and its
flags. When you do not remember a flag, ask the CLI: call \`ai_cli\` with the name of the CLI and ["--help"] —
the help is a local text, it calls no model and costs nothing. The manual of the family is in \`ai_cli_help\`.
The rules of a free call are the rules of every tool: the command runs in the working directory, every path
of it stays inside that directory, the file that is written lands in the directory the task names, and a
command that does not finish on its own is refused.`;
