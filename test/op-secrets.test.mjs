import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpRef, sameSite, resolveOpRefs, scrubSecrets } from "../op-secrets.js";

// A fake op CLI: one item saved for the-internet.herokuapp.com, one with no website.
function fakeOp() {
  const calls = [];
  const items = {
    "Demo Login": { urls: [{ href: "https://the-internet.herokuapp.com/login" }], secret: "SuperSecretPassword!" },
    "No Site": { urls: [], secret: "orphan" },
  };
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "item") return JSON.stringify({ title: args[2], urls: items[args[2]].urls });
    if (args[0] === "read") return items[decodeURIComponent(args[2].split("/")[3])].secret;
    throw new Error("unexpected op call " + args.join(" "));
  };
  return { run, calls, reads: () => calls.filter((c) => c[0] === "read") };
}

const REF = "op://Private/Demo%20Login/password";
const LOGIN = "https://the-internet.herokuapp.com/login";

test("only op://vault/item/field counts as a reference", () => {
  assert.equal(isOpRef(REF), true);
  assert.equal(isOpRef("op://Private/Demo Login/section/password"), true);
  assert.equal(isOpRef("op://Private/password"), false);
  assert.equal(isOpRef("hunter2"), false);
  assert.equal(isOpRef(undefined), false);
});

test("a page matches its item's host or a subdomain of it, never a sibling or parent", () => {
  assert.equal(sameSite("https://example.com/a", "example.com"), true);
  assert.equal(sameSite("https://www.example.com/", "https://example.com"), true);
  assert.equal(sameSite("https://login.example.com/", "https://example.com"), true);
  assert.equal(sameSite("https://example.com/", "https://login.example.com"), false);
  assert.equal(sameSite("https://evil-example.com/", "https://example.com"), false);
  assert.equal(sameSite("https://example.com.evil.io/", "https://example.com"), false);
});

test("plain values pass through without calling op", async () => {
  const op = fakeOp();
  assert.deepEqual(await resolveOpRefs(["tomsmith", "x"], LOGIN, op), ["tomsmith", "x"]);
  assert.equal(op.calls.length, 0);
});

test("a reference resolves on its item's own site", async () => {
  const op = fakeOp();
  assert.deepEqual(await resolveOpRefs(["tomsmith", REF], LOGIN, op), ["tomsmith", "SuperSecretPassword!"]);
  assert.deepEqual(op.calls[0], ["item", "get", "Demo Login", "--vault", "Private", "--format", "json"]);
  assert.deepEqual(op.reads(), [["read", "--no-newline", REF]]);
});

test("another site is refused before the secret is read", async () => {
  const op = fakeOp();
  await assert.rejects(resolveOpRefs([REF], "https://example.com/", op), /belongs to the-internet\.herokuapp\.com, not example\.com/);
  assert.equal(op.reads().length, 0);
});

test("http pages, unknown URLs and items without a website are refused", async () => {
  const op = fakeOp();
  await assert.rejects(resolveOpRefs([REF], "http://the-internet.herokuapp.com/login", op), /not https/);
  await assert.rejects(resolveOpRefs([REF], undefined, op), /URL is unknown/);
  await assert.rejects(resolveOpRefs(["op://Private/No Site/password"], LOGIN, op), /has no website/);
  assert.equal(op.reads().length, 0);
});

test("one refused reference stops the whole call before any secret is read", async () => {
  const op = fakeOp();
  await assert.rejects(resolveOpRefs([REF, "op://Private/No Site/password"], LOGIN, op), /has no website/);
  assert.equal(op.reads().length, 0);
});

test("scrubbing removes every echo of a secret", () => {
  const out = scrubSecrets('Filled INPUT "SuperSecretPassword!" (SuperSecretPassword!)', ["SuperSecretPassword!"]);
  assert.equal(out.includes("SuperSecretPassword!"), false);
  assert.equal(scrubSecrets("Filled INPUT: 20 chars", ["", "x9"]), "Filled INPUT: 20 chars");
});
