/**
 * @file src/agent/tool-specs.js
 * @module agent/tool-specs
 * @purpose The catalogue of the tools the roles may call: their names, their parameters and the
 *          config switch that turns each of them off.
 *
 *   The catalogue lives apart from the executor on purpose. The executor knows what a crop does;
 *   the catalogue knows what the model is told about it. The description the model reads is part
 *   of the behaviour of a tool: a vague description makes the model guess the arguments, and the
 *   guess is paid for in a failed call and a wasted turn.
 *
 *   The config switches are named after the domain (`image_crop`), not after the wire name
 *   (`crop_image`), because the switches describe what a user turns off, and a user thinks in
 *   domains. The mapping lives here, in one place.
 *
 * @exports TOOL_SPECS, TOOL_NAMES, CONFIG_KEYS, toolSpecs, toolEnabled, configKeyFor
 * @ai.tags tools, specs, config
 * @ai.hint keep
 */

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const int = (description) => ({ type: 'integer', description });

/**
 * Every tool the decomposer knows, with the schema of its arguments.
 *
 * `configKey` is the switch in `config.tools` that disables the tool; `roles` lists the roles the
 * tool belongs to (an empty list means every role may use it).
 * @type {Readonly<Record<string, {configKey: string, description: string, parameters: object, required: string[], roles: string[]}>>}
 */
export const TOOL_SPECS = Object.freeze({
    view_image: {
        configKey: 'image_view',
        description: 'Look at an image file and read its pixel size. Use it before cropping or projecting a picture.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the image file, relative to the working directory.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: ['decomposer', 'rectifier', 'restorer', 'overlap'],
    },
    crop_image: {
        configKey: 'image_crop',
        description: 'Cut a rectangle out of an image and write it to a file. The rectangle is clamped to the picture.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                x: int('Left edge of the rectangle in pixels.'),
                y: int('Top edge of the rectangle in pixels.'),
                width: int('Width of the rectangle in pixels.'),
                height: int('Height of the rectangle in pixels.'),
                output: str('Path of the written file. Empty = next to the source with a -crop suffix.'),
            },
            required: ['path', 'x', 'y', 'width', 'height'],
            additionalProperties: false,
        },
        required: ['path', 'x', 'y', 'width', 'height'],
        roles: ['decomposer', 'rectifier', 'restorer', 'overlap'],
    },
    split_image: {
        configKey: 'image_split',
        description: 'Cut an image into a grid of equal tiles. Use it for a regular grid of frames, not for free-form screens.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                rows: int('Number of rows in the grid.'),
                cols: int('Number of columns in the grid.'),
                outputDir: str('Directory the tiles are written to. Empty = the working directory.'),
            },
            required: ['path', 'rows', 'cols'],
            additionalProperties: false,
        },
        required: ['path', 'rows', 'cols'],
        roles: ['decomposer'],
    },
    compare_images: {
        configKey: 'image_compare',
        description: 'Compare two images pixel by pixel and report how much of the picture changed.',
        parameters: {
            type: 'object',
            properties: {
                before: str('Path of the first image.'),
                after: str('Path of the second image.'),
            },
            required: ['before', 'after'],
            additionalProperties: false,
        },
        required: ['before', 'after'],
        roles: ['extender', 'restorer', 'overlap'],
    },
    correct_perspective: {
        configKey: 'image_correct_perspective',
        description: 'Map four corners of a screen onto an upright rectangle with a projective transform. '
            + 'It preserves the pixels of the picture instead of re-drawing it, and it reports the tilt that is '
            + 'left in the result. Call it once per picture, on the original — never on a file it already wrote.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the source image.'),
                corners_json: str('JSON array of four corners in the order top-left, top-right, bottom-left, bottom-right: [{"x":0,"y":0},...].'),
                output: str('Path of the written file. Empty = next to the source with a -rectified suffix.'),
            },
            required: ['path', 'corners_json'],
            additionalProperties: false,
        },
        required: ['path', 'corners_json'],
        roles: ['decomposer', 'rectifier'],
    },
    generate_image: {
        configKey: 'image_generate',
        description: 'Draw a new picture from a prompt.',
        parameters: {
            type: 'object',
            properties: {
                prompt: str('What to draw.'),
                output: str('Path of the written file. Empty = generated.png.'),
                size: str('Size of the picture, like 1024x1024.'),
            },
            required: ['prompt'],
            additionalProperties: false,
        },
        required: ['prompt'],
        roles: ['decomposer'],
    },
    edit_image: {
        configKey: 'image_edit',
        description: 'Change a picture with a prompt. The result is written next to the source unless a path is given.',
        parameters: {
            type: 'object',
            properties: {
                image: str('Path of the picture to edit.'),
                prompt: str('What to change.'),
                output: str('Path of the written file. Empty = next to the source with a -edited suffix.'),
            },
            required: ['image', 'prompt'],
            additionalProperties: false,
        },
        required: ['image', 'prompt'],
        roles: ['decomposer', 'restorer', 'overlap'],
    },
    read_file: {
        configKey: 'read',
        description: 'Read a text file from the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
            },
            required: ['path'],
            additionalProperties: false,
        },
        required: ['path'],
        roles: [],
    },
    write_file: {
        configKey: 'write',
        description: 'Write a text file into the working directory.',
        parameters: {
            type: 'object',
            properties: {
                path: str('Path of the file, relative to the working directory.'),
                content: str('The text to write.'),
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        required: ['path', 'content'],
        roles: [],
    },
});

/** The names of every tool, in catalogue order. */
export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

/** The config switches of the tools, in catalogue order. */
export const CONFIG_KEYS = Object.freeze(TOOL_NAMES.map((name) => TOOL_SPECS[name].configKey));

/**
 * The config switch that belongs to a tool.
 * @param {string} name tool name
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function configKeyFor(name) {
    return TOOL_SPECS[name]?.configKey ?? null;
}

/**
 * Whether a tool is switched on in the config.
 *
 * A tool that is not mentioned in `config.tools` is on: the config lists the exceptions, not the
 * permissions.
 *
 * @param {object} tools the `tools` section of the config
 * @param {string} name tool name
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function toolEnabled(tools, name) {
    const key = configKeyFor(name);
    if (!key) return false;
    return tools?.[key] !== false;
}

/**
 * Build the tool definitions in the Responses API shape.
 *
 * @param {object} [tools] the `tools` section of the config; a false value switches the tool off
 * @param {{ names?: string[]|null, role?: string|null, imageApi?: boolean }} [options]
 *   `names` limits the list to these tools, `role` limits it to the tools of that role.
 * @returns {object[]}
 * @exports
 * @ai.hint pure
 */
export function toolSpecs(tools = {}, { names = null, role = null, imageApi = false } = {}) {
    const wanted = new Set(names ?? TOOL_NAMES);
    const out = [];
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
        if (!wanted.has(name)) continue;
        if (!toolEnabled(tools, name)) continue;
        if (spec.roles.length && role && !spec.roles.includes(role)) continue;
        if (!imageApi && (name === 'generate_image' || name === 'edit_image')) continue;
        out.push({
            type: 'function',
            name,
            description: spec.description,
            parameters: spec.parameters,
        });
    }
    return out;
}

/**
 * The names of the tools that are switched on for a role.
 *
 * @param {object} tools the `tools` section of the config
 * @param {{ role?: string|null, imageApi?: boolean }} [options]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function enabledToolNames(tools = {}, { role = null, imageApi = false } = {}) {
    return toolSpecs(tools, { role, imageApi }).map((spec) => spec.name);
}
