/**
 * @file test/offline.test.js
 * @module test/offline
 * @purpose The guard of the offline suite: the unit tests of the package talk to the machine
 *          and to nobody else.
 *
 * @depends node:test, test/offline-guard
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { install, isLocalHost, isNetworkAllowed, isOfflineGuardOn } from './offline-guard.js';

test('the guard knows the hosts of the machine', () => {
    assert.equal(isLocalHost('localhost'), true);
    assert.equal(isLocalHost('127.0.0.1'), true);
    assert.equal(isLocalHost('127.1.2.3'), true);
    assert.equal(isLocalHost('::1'), true);
    assert.equal(isLocalHost('[::1]'), true);
    assert.equal(isLocalHost('example.com'), false);
    assert.equal(isLocalHost('routerai.ru'), false);
    assert.equal(isLocalHost(''), false);
});

test('the network is off unless the flag of the package says so', () => {
    assert.equal(isNetworkAllowed({}), false);
    assert.equal(isNetworkAllowed({ AI_TEST_NETWORK_TESTS: '0' }), false);
    assert.equal(isNetworkAllowed({ AI_TEST_NETWORK_TESTS: '1' }), true);
    assert.equal(isNetworkAllowed({ AI_TEST_NETWORK_TESTS: 'true' }), true);
    assert.equal(isNetworkAllowed({ AI_SOMETHING_ELSE: '1' }), false);
});

test('a request outside the machine is refused', async () => {
    if (isNetworkAllowed()) return;
    install();
    await assert.rejects(() => fetch('https://example.com/'), /must stay offline/);
    await assert.rejects(() => fetch('https://routerai.ru/api/v1/models'), /must stay offline/);
});

test('the guard is on', () => {
    if (isNetworkAllowed()) return;
    assert.equal(isOfflineGuardOn(), true);
    assert.equal(install(), true);
});
