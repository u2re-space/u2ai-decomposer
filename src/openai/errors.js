/**
 * @file src/openai/errors.js
 * @module openai/errors
 * @purpose Error types for API failures and cancellation.
 * @exports ApiError, isAbortError
 * @ai.tags errors
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

/** Error raised for any failure while talking to the API. */
export class ApiError extends Error {
    /**
     * Copy status, request ids and retry metadata onto the error. The response body
     * is kept only when it is passed in.
     * @param {string} message
     * @param {object} [options]
     * @returns {void}
     * @ai.hint pure
     */
    constructor(message, {
        code = 'API_ERROR', status = null, requestId = null, clientRequestId = null, responseId = null,
        retryAfter = null, apiCode = null, apiType = null, param = null, retryable = false, cause, details = null,
    } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'ApiError';
        Object.assign(this, {
            code, status, requestId, clientRequestId, responseId, retryAfter,
            apiCode, apiType, param, retryable, details,
        });
    }

    /** Response bodies and prompts are deliberately excluded from the log representation. */
    toJSON() {
        return {
            name: this.name, code: this.code, message: this.message, status: this.status,
            requestId: this.requestId, clientRequestId: this.clientRequestId, responseId: this.responseId,
            retryAfter: this.retryAfter, apiCode: this.apiCode, apiType: this.apiType, param: this.param,
            retryable: this.retryable,
        };
    }
}

/**
 * True for an AbortError, ABORT_ERR, or a cancelled request.
 * @param {*} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export const isAbortError = (error) =>
    error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
