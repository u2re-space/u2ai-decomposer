/**
 * @file src/cli/input-state.js
 * @module cli/input-state
 * @purpose The transport-independent state of the operator of a run.
 *
 *   The terminal channel and the worker channel use the same rules: ordinary text
 *   steers the next role turn, a named skip waits for its stage or step, and quit
 *   stops the run on the next safe boundary. Keeping these rules here prevents the
 *   two frontends from drifting apart.
 *
 * @depends none
 * @usedBy cli/input, cli/worker
 * @exports createInputState
 * @ai.tags cli, input, operator
 */

/**
 * Create the state of one operator.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createInputState() {
    let steering = [];
    let skips = [];
    let stepSkips = new Set();
    let location = null;
    let quit = false;

    return {
        /**
         * Add ordinary operator text.
         * @param {string} text
         * @returns {void}
         */
        addSteering(text) {
            const line = String(text ?? '').trim();
            if (line) steering.push(line);
        },

        /**
         * Take the steering text that has not been used yet.
         * @returns {string[]}
         */
        takeSteering() {
            const out = steering;
            steering = [];
            return out;
        },

        /**
         * Ask for a stage or a step to be skipped.
         * @param {string|null} [target] the name of the stage or step
         * @param {object|null} [where] the place where the request was made
         * @returns {void}
         */
        addSkip(target = null, where = null) {
            skips.push({
                target: target ? String(target).toLowerCase() : null,
                location: where && typeof where === 'object' ? { ...where } : null,
            });
        },

        /**
         * Take a skip that belongs to the given stage or step.
         * @param {{ stage?: string, step?: string }} [request]
         * @returns {object|null}
         */
        takeSkip({ stage = '', step = '' } = {}) {
            const stageName = String(stage).toLowerCase();
            const stepName = String(step).toLowerCase();
            const index = skips.findIndex((item) => {
                if (!item.target) {
                    return (item.location?.step
                        ? String(item.location.step).toLowerCase() === stepName
                        : String(item.location?.stage ?? '').toLowerCase() === stageName);
                }
                return item.target === stageName || (stepName && item.target === stepName);
            });
            return index < 0 ? null : skips.splice(index, 1)[0];
        },

        /**
         * Take the skip bound to the current place of the run.
         * @returns {object|null}
         */
        takeCurrentSkip() {
            const where = location;
            const index = skips.findIndex((item) => !item.target
                && ((item.location?.step === where?.step && where?.step)
                    || (item.location?.stage === where?.stage && !where?.step && where?.stage)));
            return index < 0 ? null : skips.splice(index, 1)[0];
        },

        /**
         * Take the skips that name their stage or step.
         * @param {{ namedOnly?: boolean, includeCurrent?: boolean }} [options]
         * @returns {object[]}
         */
        takePendingSkips({ namedOnly = false, includeCurrent = false } = {}) {
            if (!namedOnly && includeCurrent) return skips.splice(0);
            const named = skips.filter((item) => item.target);
            for (const item of named) skips.splice(skips.indexOf(item), 1);
            return named;
        },

        /**
         * Remember the place of the run.
         * @param {object|null} next
         * @returns {void}
         */
        setLocation(next) {
            location = next && typeof next === 'object' ? { ...next } : null;
        },

        /**
         * The place of the run.
         * @returns {object|null}
         */
        location() {
            return location ? { ...location } : null;
        },

        /**
         * Mark a named plan step to be skipped.
         * @param {string} id
         * @returns {void}
         */
        queueStepSkip(id) {
            stepSkips.add(String(id ?? '').toLowerCase());
        },

        /**
         * Take a named plan step to be skipped.
         * @param {string} id
         * @returns {boolean}
         */
        takeStepSkip(id) {
            const key = String(id ?? '').toLowerCase();
            if (!stepSkips.has(key)) return false;
            stepSkips.delete(key);
            return true;
        },

        /**
         * Ask the run to stop on the next safe boundary.
         * @returns {void}
         */
        requestQuit() {
            quit = true;
        },

        /**
         * Whether the operator asked the run to stop.
         * @returns {boolean}
         */
        shouldQuit() {
            return quit;
        },
    };
}
