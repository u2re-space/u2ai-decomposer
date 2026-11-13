/**
 * @file src/openai/completions.js
 * @purpose Chat Completions transport fallback when Responses API is unavailable.
 * @exports completionsToResponse
 * @ai.hint keep
 */

/**
 * Convert a /chat/completions response to the Responses API shape.
 * @param {object} chatResult
 * @returns {object}
 */
export function completionsToResponse(chatResult) {
    const msg = chatResult?.choices?.[0]?.message;
    return {
        status: chatResult?.choices?.[0]?.finish_reason === 'stop' ? 'completed' : 'incomplete',
        output: [{ type: 'message', content: [{ type: 'text', text: msg?.content ?? '' }] }],
        messages: [{ role: 'assistant', content: [{ type: 'text', text: msg?.content ?? '' }] }],
    };
}