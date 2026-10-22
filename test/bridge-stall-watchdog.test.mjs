#!/usr/bin/env node
/**
 * After the Mac slept (22.10.26: lid closed 05:27, bridge dropped 05:35), the worker never
 * reconnected through two full wakes, for 12.5 hours, until the user opened Safari's Extensions
 * settings. The daemon logged no /connect at all in that time. Every recovery path, the minute
 * alarm and the page keepalive ping, skips a worker that is connecting or connected, so a
 * connect() parked on a Safari call that never settles (storage, IPC) or a poll loop gone silent
 * with isConnected still true is never retried. Past a bound the watchdog takes the lock over.
 *
 * Run:  node --test test/bridge-stall-watchdog.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function sourceBetween(startNeedle, endNeedle) {
  const start = background.indexOf(startNeedle);
  const end = background.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return background.slice(start, end);
}

const flush = async () => {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// connect(), its watchdog and the minute alarm, with a clock and a storage read the test controls.
function harness({ hangFirstStorageRead = false } = {}) {
  let now = 1_000_000;
  let handshakes = 0;
  const polls = [];
  let releaseStorage = null;
  let storageReads = 0;
  let alarm = null;
  const api = Function(
    "_bridgeFetch", "browser", "_storedReloadHandoffToken", "_verifyProfileMatch",
    "_discoverProfileWindow", "updateBadge", "_startHeartbeat", "_stopHeartbeat",
    "pollForCommands", "AbortSignal", "setTimeout", "clearTimeout", "Date", "console",
    `const BRIDGE_PORTS = [9224];
     const _EXTENSION_BUILD = "test-build";
     let HTTP_URL = "http://127.0.0.1:9224";
     let _enabled = true;
     let _bridgeWorkerSuperseded = false;
     let _bridgeWorkerRetiring = false;
     let pollAbort = null;
     let _pollLoopGeneration = 0;
     let isConnected = false;
     let _targetProfile = null;
     let _reconnectDelay = 3000;
     let _reconnectTimer = null;
     let _heartbeatTimer = 1;
     const _RECONNECT_MAX = 60000;
     const _BRIDGE_RELOAD_HANDOFF_KEY = "reload";
     let _commandExecutionTail = Promise.resolve();
     ${sourceBetween("let _connecting = false", "async function pollForCommands(")}
     ${sourceBetween('browser.alarms.create("keepalive"', "// ========== STARTUP")}
     return {
       connect,
       state: () => ({ isConnected, connecting: _connecting, generation: _pollLoopGeneration }),
       progress: () => { _lastPollProgressAt = Date.now(); },
     };`
  )(
    async (url) => {
      if (String(url).includes("/connect")) handshakes += 1;
      return { ok: true, status: 200, json: async () => ({ profile: null }) };
    },
    {
      storage: {
        local: {
          get: () => {
            storageReads += 1;
            // After sleep, Safari's storage answered nothing: the first read never settles until
            // the test lets it, long after the watchdog has moved on.
            if (hangFirstStorageRead && storageReads === 1) return new Promise((resolve) => { releaseStorage = () => resolve({}); });
            return Promise.resolve({});
          },
          remove: async () => {},
          set: async () => {},
        },
      },
      alarms: { create: () => {}, onAlarm: { addListener: (fn) => { alarm = fn; } } },
    },
    async () => "",
    async () => true,
    async () => {},
    () => {},
    () => {},
    () => {},
    (generation) => polls.push(generation),
    AbortSignal,
    () => 0,
    () => {},
    { now: () => now },
    { log: () => {} }
  );
  return {
    ...api,
    elapse: (ms) => { now += ms; },
    alarm: () => alarm({ name: "keepalive" }),
    releaseStorage: () => releaseStorage(),
    handshakes: () => handshakes,
    polls,
  };
}

test("the minute alarm restarts a connect parked on a Safari call for more than 30s", async () => {
  const h = harness({ hangFirstStorageRead: true });
  h.connect(); // parks on the storage read
  await flush();
  assert.equal(h.state().connecting, true);

  h.elapse(10_000);
  h.alarm();
  await flush();
  assert.equal(h.handshakes(), 0, "a connect in flight for 10s is left alone");

  h.elapse(25_000);
  h.alarm();
  await flush();
  assert.equal(h.handshakes(), 1, "the alarm never retried the parked connect");
  assert.equal(h.state().isConnected, true);
  const healthy = h.state().generation;

  // The parked call finally settles: that attempt must stand down, not tear the new loop down.
  h.releaseStorage();
  await flush();
  assert.equal(h.handshakes(), 1, "the stale attempt hand-shook again");
  assert.equal(h.state().generation, healthy, "the stale attempt invalidated the healthy poll loop");
  assert.deepEqual(h.polls, [healthy]);
});

test("the minute alarm restarts a connected worker whose poll loop made no progress for 120s", async () => {
  const h = harness();
  await h.connect();
  assert.equal(h.handshakes(), 1);

  h.elapse(100_000);
  h.progress(); // a poll answer, or a beat of a long command
  h.elapse(100_000);
  h.alarm();
  await flush();
  assert.equal(h.handshakes(), 1, "a loop that answered 100s ago is not stalled");

  h.elapse(30_000);
  h.alarm();
  await flush();
  assert.equal(h.handshakes(), 2, "a silent connected loop was never restarted");
  assert.equal(h.state().isConnected, true);
});
