import {
  hashSecret,
  LINK_CALLBACK_PATH,
  randomToken,
  type AccountId,
  type CreateLinkRequest,
  type DeviceDraft,
  type LinkId,
} from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { approve, claim, handoffUrl, startLink, viewOf, type Pending } from "../src/linking.ts";

const desktop: DeviceDraft = {
  kind: "desktop",
  name: "Attacker's PC",
  platform: "win32",
  channel: "stable",
  version: "0.5.0",
};
const browser: DeviceDraft = { ...desktop, kind: "browser", name: "iPhone", platform: "ios" };

const id = randomToken(32) as LinkId;
const victim = "user_victim" as AccountId;
const other = "user_other" as AccountId;

/** A sign-in anyone could start: no account, just a device and the hash of its own secret. */
const started = async (device: DeviceDraft = desktop) => {
  const secret = randomToken(32);
  const request: CreateLinkRequest = {
    device,
    secretHash: await hashSecret(secret),
    ...(device.kind === "desktop" ? { callback: { port: 49152 } } : {}),
  };
  const link = startLink(request, Date.now() + 60_000);
  if ("ok" in link) throw new Error(link.message);
  return { link, secret };
};

const approved = async (link: Pending, account = victim) => {
  const outcome = await approve(link, account, { email: "victim@example.com" });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome;
};

const codeIn = (next: string) =>
  next.startsWith("/app/")
    ? decodeURIComponent(next.split(".").at(-1)!)
    : new URL(next).searchParams.get("code")!;

describe("a sign-in link someone else started", () => {
  it("doesn't let its device in when the user confirms it", async () => {
    const { link, secret } = await started();
    const { link: confirmed } = await approved(link);
    // The device that started it polls with its own secret: confirming alone never joins it.
    expect(await claim(confirmed, secret, undefined)).toEqual({ _tag: "wait" });
    expect(viewOf(confirmed).status).toBe("approved");
  });

  it("sends the code to the confirming computer's own loopback address, never anywhere else", async () => {
    const { link } = await started();
    const { link: confirmed, code } = await approved(link);
    const next = new URL(handoffUrl(id, confirmed, code));
    expect(next.origin).toBe("http://127.0.0.1:49152");
    expect(next.pathname).toBe(LINK_CALLBACK_PATH);
    expect(next.searchParams.get("link")).toBe(id);
  });

  it("sends a browser's code back to the web client on the page's own origin", async () => {
    const { link } = await started(browser);
    const { link: confirmed, code } = await approved(link);
    const next = handoffUrl(id, confirmed, code);
    expect(next.startsWith("/app/#cerium-link=")).toBe(true);
    expect(codeIn(next)).toBe(code);
  });

  it("ends when its device guesses the code", async () => {
    const { link, secret } = await started();
    const { link: confirmed } = await approved(link);
    expect(await claim(confirmed, secret, randomToken(32))).toEqual({ _tag: "burn" });
  });

  it("ends when its device sends a code before anyone confirmed it", async () => {
    const { link, secret } = await started();
    expect(await claim(link, secret, randomToken(32))).toEqual({ _tag: "burn" });
  });

  it("can't be confirmed into a second account", async () => {
    const { link } = await started();
    const { link: confirmed } = await approved(link);
    const second = await approve(confirmed, other, {});
    expect(second).toMatchObject({ ok: false, status: 409 });
  });
});

describe("a sign-in started on the user's own machine", () => {
  it("joins the account once the machine claims it with the code its page handed over", async () => {
    const { link, secret } = await started();
    const { link: confirmed, code } = await approved(link);
    const outcome = await claim(confirmed, secret, codeIn(handoffUrl(id, confirmed, code)));
    expect(outcome).toEqual({ _tag: "join", account: { id: victim, email: "victim@example.com" } });
  });

  it("refuses a claim without the machine's secret, even with the code", async () => {
    const { link } = await started();
    const { link: confirmed, code } = await approved(link);
    expect(await claim(confirmed, randomToken(32), code)).toEqual({ _tag: "forbidden" });
  });

  it("takes a new code when the same account confirms again, and the old one no longer works", async () => {
    const { link, secret } = await started();
    const first = await approved(link);
    const second = await approved(first.link);
    expect(second.code).not.toBe(first.code);
    expect((await claim(second.link, secret, second.code))._tag).toBe("join");
    expect((await claim(second.link, secret, first.code))._tag).toBe("burn");
  });

  it("answers a claim made again once it joined, and can't be confirmed again", async () => {
    const { link, secret } = await started();
    const { link: confirmed } = await approved(link);
    const linked: Pending = {
      ...confirmed,
      linked: { account: { id: victim }, deviceId: "device_1" as never },
    };
    expect(await claim(linked, secret, undefined)).toEqual({
      _tag: "linked",
      account: { id: victim },
      deviceId: "device_1",
    });
    expect(viewOf(linked).status).toBe("confirmed");
    expect((await approve(linked, victim, {})).ok).toBe(false);
  });
});

describe("starting a sign-in", () => {
  it("refuses a desktop with nowhere for its page to hand the code", async () => {
    const outcome = startLink({ device: desktop, secretHash: "0".repeat(64) }, 0);
    expect("ok" in outcome && outcome.status).toBe(426);
  });

  it("refuses a browser that names a loopback port", async () => {
    const outcome = startLink({ device: browser, secretHash: "0".repeat(64), callback: { port: 49152 } }, 0);
    expect("ok" in outcome && outcome.status).toBe(400);
  });
});
