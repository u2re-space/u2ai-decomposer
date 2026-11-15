/**
 * @file test/offline-guard.js
 * @module test/offline-guard
 * @purpose The unit tests of the package stay offline: a request outside the machine is a
 *          failure, not a slow test that costs money.
 *
 *   The guard wraps every way out of the machine — `fetch`, `http.request`, `https.request`,
 *   `net.connect`, `WebSocket` — and refuses every address that is not the machine itself.
 *   The tests of the package talk to the servers of the machine and to nobody else.
 *
 *   The tests that talk to the real hosts live behind the flag of the package
 *   (`AI_<PACKAGE>_NETWORK_TESTS=1`): with the flag the guard steps aside and lets the
 *   network live.
 *
 *   The guard is loaded before the tests:
 *   `node --test --import ./test/offline-guard.js "test/*.test.js"`.
 *
 * @depends node:http, node:https, node:net
 * @exports install, isLocalHost, isNetworkAllowed, isOfflineGuardOn
 * @ai.tags test, offline, network
 * @ai.hint io
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** The flag of the package: `AI_<PACKAGE>_NETWORK_TESTS=1` lets the network live. */
const FLAG = /^AI_[A-Z0-9_]*NETWORK_TESTS$/;

/** The hosts of the machine: the tests of the package talk to them and to nobody else. */
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Whether the network is allowed: the flag of the package says so.
 *
 * Every flag of the shape `AI_<NAME>_NETWORK_TESTS` counts, so the guard of the package
 * does not have to know the name of the package it lives in.
 * @param {object} [env]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isNetworkAllowed(env = process.env) {
    for (const [name, value] of Object.entries(env ?? {})) {
        if (!FLAG.test(name)) continue;
        const text = String(value ?? '').trim().toLowerCase();
        if (text === '1' || text === 'true') return true;
    }
    return false;
}

/**
 * Whether a host is the machine itself.
 * @param {string} hostname
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isLocalHost(hostname) {
    let host = String(hostname ?? '').trim().toLowerCase();
    if (!host) return false;
    if (host.startsWith('[')) {
        // `[::1]` or `[::1]:8080` — the address of the loopback.
        const end = host.indexOf(']');
        host = end === -1 ? host.slice(1) : host.slice(1, end);
    } else if ((host.match(/:/g) ?? []).length === 1) {
        // `localhost:3000` — the port goes away.
        host = host.split(':')[0];
    }
    if (!host) return false;
    if (LOCAL.has(host)) return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The host of an address: a string, a URL, the options of a request or a Request.
 * @param {unknown} input
 * @returns {string|null}
 * @ai.hint pure
 */
function hostOf(input) {
    if (typeof input === 'string') {
        try {
            return new URL(input).hostname;
        } catch {
            return null;
        }
    }
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === 'object') {
        if (typeof input.hostname === 'string' && input.hostname) return input.hostname;
        if (typeof input.host === 'string' && input.host) return input.host;
        if (typeof input.url === 'string') {
            try {
                return new URL(input.url).hostname;
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * The address as a human reads it.
 * @param {unknown} input
 * @returns {string}
 * @ai.hint pure
 */
function describe(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input === 'object') {
        if (typeof input.url === 'string') return input.url;
        const host = input.host ?? input.hostname ?? 'the host';
        const port = input.port ? `:${input.port}` : '';
        return `${host}${port}${input.path ?? ''}`;
    }
    return String(input);
}

/**
 * The error of a refused request.
 * @param {unknown} input
 * @returns {Error}
 * @ai.hint pure
 */
function offline(input) {
    return new Error(`The unit tests must stay offline: ${describe(input)}`);
}

/**
 * Refuse an address that is not the machine.
 * @param {unknown} input
 * @returns {void}
 * @ai.hint pure
 */
function refuse(input) {
    const host = hostOf(input);
    if (host && !isLocalHost(host)) throw offline(input);
}

/**
 * Install the guard: every address outside the machine is refused.
 *
 * The guard is installed once: the second call is a no-op, so a test may import the module
 * and ask for the guard again.
 * @param {object} [env]
 * @returns {boolean} whether the guard is on
 * @exports
 * @ai.hint io
 */
export function install(env = process.env) {
    if (globalThis.__u2aiOfflineGuard) return true;
    if (isNetworkAllowed(env)) return false;
    globalThis.__u2aiOfflineGuard = true;

    const realFetch = globalThis.fetch;
    if (typeof realFetch === 'function') {
        globalThis.fetch = async (input, init) => {
            refuse(input);
            return await realFetch(input, init);
        };
    }

    for (const module of [http, https]) {
        const realRequest = module.request;
        const realGet = module.get;
        module.request = function guardedRequest(input, ...rest) {
            refuse(input);
            return realRequest.call(this, input, ...rest);
        };
        module.get = function guardedGet(input, ...rest) {
            refuse(input);
            return realGet.call(this, input, ...rest);
        };
    }

    const realConnect = net.connect;
    net.connect = function guardedConnect(...args) {
        refuse(args[0]);
        return realConnect.apply(this, args);
    };
    net.createConnection = net.connect;

    const RealWebSocket = globalThis.WebSocket;
    if (typeof RealWebSocket === 'function') {
        globalThis.WebSocket = class GuardedWebSocket extends RealWebSocket {
            /**
             * @param {string|URL} url
             * @param {string|string[]} [protocols]
             */
            constructor(url, protocols) {
                refuse(url);
                super(url, protocols);
            }
        };
    }

    return true;
}

/**
 * Whether the guard is on.
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isOfflineGuardOn() {
    return Boolean(globalThis.__u2aiOfflineGuard);
}

install();
