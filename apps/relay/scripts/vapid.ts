// Makes the relay's VAPID key pair, which signs its push notifications.
// Keep a pair once browsers subscribe with it: a new one leaves their subscriptions unable to receive
// until each opens Cerium again and resubscribes.
//
// Usage: node scripts/vapid.ts             prints a new pair
//        node scripts/vapid.ts --dev-vars  adds one to .dev.vars, unless it has one
//
// Deployed, the pair is two secrets: `wrangler secret put VAPID_PUBLIC_KEY`, then VAPID_PRIVATE_KEY.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
const lines = [`VAPID_PUBLIC_KEY=${publicKey}`, `VAPID_PRIVATE_KEY=${d}`];

if (process.argv.includes("--dev-vars")) {
  const file = join(import.meta.dirname, "..", ".dev.vars");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^VAPID_PRIVATE_KEY=/m.test(current)) {
    console.log(".dev.vars already has a VAPID key pair; it's kept.");
  } else {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${current}${separator}${lines.join("\n")}\n`, { mode: 0o600 });
    console.log("Added a VAPID key pair to .dev.vars. Restart `wrangler dev` to use it.");
  }
} else {
  console.log(lines.join("\n"));
}
