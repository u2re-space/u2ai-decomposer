/**
 * @file src/openai/responses.js
 * @module openai/responses
 * @purpose Build Responses API request bodies and parse their answers.
 * @depends openai/stream
 * @usedBy openai/client, roles/index
 * @exports buildResponsesBody, parseResponse, extractToolCalls, imagePart, textPart, functionTool
 * @ai.tags responses
 * @ai.hint pure
 */
import { normalizeUsage, outputText, refusalText } from './stream.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');

/**
 * A text input part.
 * @param {string} text
 * @returns {object}
 * @ai.hint pure
 */
export function textPart(text) {
    return { type: 'input_text', text: String(text ?? '') };
}

/**
 * An image input part from raw bytes: the API takes a data URL, not a file.
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mime image mime type
 * @returns {object}
 * @ai.hint pure
 */
export function imagePart(bytes, mime = 'image/png') {
    const data = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
    return { type: 'input_image', image_url: `data:${mime};base64,${data}` };
}

/**
 * A function tool definition in the Responses shape.
 * @param {string} name
 * @param {string} description
 * @param {object} parameters JSON schema of the arguments
 * @returns {object}
 * @ai.hint pure
 */
export function functionTool(name, description, parameters) {
    return {
        type: 'function',
        name,
        description,
        parameters: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    };
}

/**
 * Build the body of a Responses API request.
 *
 * The builder is the only place that knows the wire names, so the stages speak in
 * domain terms (instructions, a text prompt, attached images, a JSON schema) and the
 * transport stays replaceable.
 * @param {object} params
 * @param {string} params.model model id
 * @param {string|null} [params.instructions] system instructions of the role
 * @param {string|object[]|null} [params.input] user text or ready input items
 * @param {object[]} [params.parts] extra input parts (images) for the user message
 * @param {object[]} [params.tools] function tools
 * @param {object|null} [params.schema] JSON schema the answer must follow
 * @param {string} [params.schemaName] name of the schema tool
 * @param {string|null} [params.effort] reasoning effort
 * @param {string|null} [params.summary] reasoning summary mode
 * @param {string|null} [params.mode] gateway reasoning mode
 * @param {number|null} [params.maxOutputTokens]
 * @param {number|null} [params.temperature]
 * @param {boolean} [params.store] send `store: true`
 * @param {string|null} [params.truncation]
 * @param {boolean} [params.stream]
 * @param {string|null} [params.previousResponseId]
 * @returns {object} the request body
 */
export function buildResponsesBody({
    model,
    instructions = null,
    input = null,
    parts = null,
    tools = null,
    schema = null,
    schemaName = 'response',
    strict = true,
    effort = null,
    summary = null,
    mode = null,
    maxOutputTokens = null,
    temperature = null,
    store = false,
    truncation = null,
    verbosity = null,
    stream = false,
    previousResponseId = null,
    toolChoice = null,
    parallelToolCalls = null,
} = {}) {
    const body = { model };
    if (textOf(instructions).trim()) body.instructions = textOf(instructions);
    if (previousResponseId) body.previous_response_id = previousResponseId;

    // Input: a ready item list is passed through, text and parts are packed into one user message.
    if (Array.isArray(input)) {
        body.input = input;
    } else {
        const content = [];
        const text = textOf(input);
        if (text.trim()) content.push(textPart(text));
        for (const part of Array.isArray(parts) ? parts : []) {
            if (!part) continue;
            content.push(part);
        }
        body.input = content.length
            ? [{ role: 'user', content }]
            : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];
    }

    const toolList = Array.isArray(tools) ? tools.filter((tool) => isRecord(tool)) : [];
    if (isRecord(schema)) {
        toolList.push({
            type: 'function',
            name: schemaName,
            description: `Answer with the ${schemaName} JSON schema.`,
            parameters: schema,
            strict,
        });
    }
    if (toolList.length) body.tools = toolList;
    if (toolChoice) body.tool_choice = toolChoice;
    if (parallelToolCalls === true) body.parallel_tool_calls = true;

    if (isRecord(schema)) {
        body.text = { format: { type: 'json_schema', name: schemaName, schema, strict } };
    }

    const reasoning = {};
    if (effort) reasoning.effort = effort;
    if (summary) reasoning.summary = summary;
    if (mode && mode !== 'off') reasoning.mode = mode;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;

    if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_output_tokens = maxOutputTokens;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (typeof verbosity === 'string') body.text = { ...(body.text ?? {}), verbosity };
    if (store) body.store = true;
    if (textOf(truncation)) body.truncation = truncation;
    if (stream) body.stream = true;
    return body;
}

/**
 * Tool calls of a response, in the shape the stage code reads.
 * @param {object} raw a Responses API answer
 * @returns {Array<{ id: string|null, name: string, arguments: object, raw: string }>}
 */
export function extractToolCalls(raw) {
    const out = [];
    for (const item of Array.isArray(raw?.output) ? raw.output : []) {
        if (item?.type !== 'function_call') continue;
        const rawArgs = textOf(item.arguments) || '{}';
        let args = {};
        try { args = JSON.parse(rawArgs); } catch { args = {}; }
        out.push({ id: item.id ?? null, callId: item.call_id ?? null, name: textOf(item.name), arguments: args, raw: rawArgs });
    }
    return out;
}

/**
 * Parse a Responses API answer into a stable shape.
 *
 * `text` is the whole answer, `data` is the answer parsed as JSON (null when it is not JSON),
 * `toolCalls` are the function calls the model asked for.
 * @param {object} raw
 * @returns {{ id: string|null, status: string, model: string|null, text: string, data: object|null, toolCalls: object[], usage: object|null, refusal: string, error: object|null, raw: object }}
 */
export function parseResponse(raw) {
    const text = textOf(raw?.output_text) || outputText(raw);
    let data = null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { data = JSON.parse(trimmed); } catch { data = null; }
    }
    return {
        id: raw?.id ?? null,
        status: raw?.status ?? 'completed',
        model: raw?.model ?? null,
        text,
        data,
        toolCalls: extractToolCalls(raw),
        usage: normalizeUsage(raw?.usage),
        refusal: refusalText(raw),
        error: raw?.error ?? null,
        raw,
    };
}
