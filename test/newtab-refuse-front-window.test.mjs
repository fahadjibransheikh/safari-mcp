import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Without SAFARI_PROFILE, AppleScript can open a tab only in `front window`, which is the user's;
// only the extension opens one in the agent window. With the extension bridge down (found live on
// 22.10.26, after its worker stopped polling for 12 hours), safari_new_tab and run_script newTab
// fell back to AppleScript and opened the session's tabs among the user's. With
// SAFARI_MCP_REQUIRE_EXTENSION they now refuse.

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const openTab = between(index, "function _refuseFrontWindowTab(", "\n// Open a tab through AppleScript")
  + between(index, "async function _openTabViaAppleScript(", "\n}\n") + "\n}\n";

function load(env) {
  const opened = [];
  const safari = {
    newTab: async (url) => { opened.push(url); return JSON.stringify({ tabIndex: 2 }); },
    getActiveTabIndex: () => 2, setActiveTabURL() {},
  };
  const fn = new Function(
    "safari", "process", "SESSION_ID", "currentSessionId", "_trackTab", "_markBlankTabOpened", "_claimURL",
    `${openTab}\nreturn _openTabViaAppleScript;`
  )(safari, { env }, "daemon", () => "s1", () => {}, () => {}, () => {});
  return { open: fn, opened };
}

for (const value of ["1", "true", "on"]) {
  test(`with SAFARI_MCP_REQUIRE_EXTENSION=${value}, the AppleScript fallback refuses to open a tab in the user's front window`, async () => {
    const { open, opened } = load({ SAFARI_MCP_REQUIRE_EXTENSION: value });
    await assert.rejects(open("https://example.com/"), /Safari extension could not open it/);
    assert.deepEqual(opened, [], "AppleScript opened a tab anyway");
  });
}

for (const env of [{}, { SAFARI_MCP_REQUIRE_EXTENSION: "0" }]) {
  test(`with SAFARI_MCP_REQUIRE_EXTENSION=${env.SAFARI_MCP_REQUIRE_EXTENSION ?? "unset"}, AppleScript-only setups still open tabs`, async () => {
    const { open, opened } = load(env);
    await open("https://example.com/");
    assert.deepEqual(opened, ["https://example.com/"]);
  });
}

test("with SAFARI_PROFILE, the AppleScript fallback still opens the tab in the profile's window", async () => {
  const { open, opened } = load({ SAFARI_PROFILE: "Work", SAFARI_MCP_REQUIRE_EXTENSION: "1" });
  await open("https://example.com/");
  assert.deepEqual(opened, ["https://example.com/"]);
});

test("the batch newTab fallback refuses too, before AppleScript runs", () => {
  const batchNewTab = between(index, "async function _runExtensionBatchAction(", "\n    case \"switchTab\"");
  assert.match(batchNewTab, /viaAppleScript = true;\s*_refuseFrontWindowTab\(\);\s*return safari\.newTab\(/);
});
