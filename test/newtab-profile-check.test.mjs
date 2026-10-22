import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Found live on 22.10.26: once a session's own tab was gone, handleCommand resolved the tab in front,
// the user's, and its "different profile" check refused new_tab because that tab was outside the
// session's window. index.js then opened the tab through AppleScript, in the user's front window.
// new_tab never acts on that tab (_newTabForSession picks its window itself), so the check skips it.

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const from = background.indexOf("  const sessionWindow = _windowForSession(sessionId);");
const to = background.indexOf("// ========== TAB OWNERSHIP GUARD", from);
assert.ok(from >= 0 && to > from, "could not extract the profile check");
const check = new Function("type", "sessionId", "tabId", "targetTab", "_windowForSession",
  background.slice(from, to));

const AGENT = 202; // the session's window
const USER = 92; // the user's front window
const userTab = { id: 7, windowId: USER };

test("new_tab is not refused when the resolved tab is the user's, in another window", () => {
  assert.doesNotThrow(() => check("new_tab", "s1", userTab.id, userTab, () => AGENT));
});

test("other commands are still refused on a tab outside the session's window", () => {
  for (const type of ["navigate", "evaluate", "click", "read_page"]) {
    assert.throws(() => check(type, "s1", userTab.id, userTab, () => AGENT), /different profile/, type);
  }
});

test("a tab in the session's own window passes", () => {
  assert.doesNotThrow(() => check("navigate", "s1", 9, { id: 9, windowId: AGENT }, () => AGENT));
});
