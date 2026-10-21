// 1Password secret references for the fill tools. A fill value written as op://vault/item/field
// is resolved here, in the daemon, so the secret never travels through the MCP client: the agent
// passes the reference, the page gets the value, and the transcript only ever shows the reference.
// A reference can be planted by page content the agent read, so a secret is only released to a
// page on the same site as the website saved on its 1Password item, and only over https.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const OP_REF = /^op:\/\/([^/]+)\/([^/]+)\/.+/;

export function isOpRef(value) {
  return typeof value === "string" && OP_REF.test(value);
}

// The launchd daemon's PATH has no /opt/homebrew/bin, so look for op where installers put it.
export function opBinary(env = process.env) {
  if (env.SAFARI_MCP_OP_BIN) return env.SAFARI_MCP_OP_BIN;
  return ["/opt/homebrew/bin/op", "/usr/local/bin/op"].find((p) => existsSync(p)) || "op";
}

function runOp(args) {
  return new Promise((resolve, reject) => {
    execFile(opBinary(), args, { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`1Password CLI: ${(stderr || err.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Same site: the page's host is the item's host or a subdomain of it (login.example.com for an
// item saved as example.com). Never the other way round: an item for login.example.com must not
// fill a page on example.com or on another subdomain.
export function sameSite(pageUrl, itemUrl) {
  const page = hostOf(pageUrl);
  const item = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(itemUrl) ? itemUrl : `https://${itemUrl}`);
  return !!page && !!item && (page === item || page.endsWith(`.${item}`));
}

// Resolves every op:// value in `values` for the page at `pageUrl`. Returns the plain values in
// the same order. Checks every reference's item before reading any secret, so a refused call
// reads none. `run` is injectable for tests.
export async function resolveOpRefs(values, pageUrl, { run = runOp } = {}) {
  const refs = values.filter(isOpRef);
  if (!refs.length) return values;
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    throw new Error("op:// refused: the tab's URL is unknown, so the secret's site cannot be checked.");
  }
  if (page.protocol !== "https:") {
    throw new Error(`op:// refused: ${page.origin} is not https.`);
  }
  for (const ref of new Set(refs)) {
    const [, vault, item] = ref.match(OP_REF);
    const json = JSON.parse(await run(["item", "get", decodeURIComponent(item), "--vault", decodeURIComponent(vault), "--format", "json"]));
    const urls = (json.urls || []).map((u) => u.href).filter(Boolean);
    if (!urls.length) {
      throw new Error(`op:// refused: the 1Password item for ${ref} has no website, so it cannot be matched to ${page.hostname}.`);
    }
    if (!urls.some((u) => sameSite(page.href, u))) {
      throw new Error(`op:// refused: ${ref} belongs to ${urls.map(hostOf).join(", ")}, not ${page.hostname}.`);
    }
  }
  const resolved = new Map();
  for (const ref of new Set(refs)) resolved.set(ref, await run(["read", "--no-newline", ref]));
  return values.map((v) => (isOpRef(v) ? resolved.get(v) : v));
}

// Replaces any resolved secret in tool output or error text, in case a fill path echoes its value.
export function scrubSecrets(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("••••");
  return out;
}
