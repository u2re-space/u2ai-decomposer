/**
 * @file src/openai/responses.js
 * @purpose Responses API route helpers (tool calls, streaming, structured output).
 * @exports parseResponse, extractToolCalls
 * @ai.hint keep
 */

/**
 * Parse a Responses API result into a normalised shape.
 * @param {object} raw
 * @returns {{ status: string, text: string, toolCalls: object[], data: object|null }}
 */
export function parseResponse(raw) {
    const text = raw?.output?.[0]?.content?.[0]?.text ?? raw?.messages?.[0]?.content?.[0]?.text ?? '';
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: raw?.status ?? 'completed', text, toolCalls: raw?.output?.filter(o => o.type === 'function_call') ?? [], data };
}

/**
 * Extract tool call entries from a response.
 * @param {object} raw
 * @returns {Array<{name:string,args:object}>}
 */
export function extractToolCalls(raw) {
    return (raw?.output ?? [])
        .filter((o) => o.type === 'function_call')
        .map((o) => ({ name: o.name, args: JSON.parse(o.arguments ?? '{}') }));
}