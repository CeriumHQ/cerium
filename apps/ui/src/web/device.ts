import { Account, CloudThreads, Vault, VaultError, type HandedCode, type LinkHandoff } from "@cerium/account";
import { Installation, randomToken, type DeviceDraft } from "@cerium/protocol";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { BUILD_VERSION } from "../backend/target.ts";

// The web client as a device of the account: its sign-in, its relay
// connection and the account's threads, running in the page. Both RPC clients use this one layer,
// which the atom runtimes' shared memo map builds once.

const SIGN_IN_KEY = "cerium:device";
const INSTALLATION_KEY = "cerium:installation";

const blocked = new VaultError({
  message: "This browser keeps no data for Cerium's site, so it can't stay signed in. Allow site data.",
});

/** The sign-in, in the browser's storage for the relay's origin only. */
const browserVault = Layer.succeed(
  Vault,
  Vault.of({
    read: Effect.try({ try: () => localStorage.getItem(SIGN_IN_KEY) ?? undefined, catch: () => blocked }),
    write: (value) =>
      Effect.try({
        try: () =>
          value === undefined
            ? localStorage.removeItem(SIGN_IN_KEY)
            : localStorage.setItem(SIGN_IN_KEY, value),
        catch: () => blocked,
      }),
  }),
);

/** Node's names for the systems a desktop reports, and a phone's own. */
const platformOf = (agent: string): string => {
  // iPadOS asks for the desktop site as a Mac; only its touch screen tells it apart.
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1))
    return "ios";
  if (/Android/.test(agent)) return "android";
  if (/Windows/.test(agent)) return "win32";
  if (/Macintosh|Mac OS X/.test(agent)) return "darwin";
  if (/Linux|CrOS/.test(agent)) return "linux";
  return "web";
};

const browserOf = (agent: string): string =>
  /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "A browser";

const systemName: Record<string, string> = { win32: "Windows", darwin: "Mac", linux: "Linux" };

/** "iPhone", "iPad", "Android phone", or "Chrome on Windows": until the user renames it. */
const nameOf = (agent: string, platform: string): string => {
  if (platform === "ios") return /iPad/.test(agent) || !/iPhone|iPod/.test(agent) ? "iPad" : "iPhone";
  if (platform === "android") return /Mobile/.test(agent) ? "Android phone" : "Android tablet";
  return `${browserOf(agent)} on ${systemName[platform] ?? "the web"}`;
};

/** How this browser describes itself when it signs in. */
export const thisBrowser = (): DeviceDraft => {
  const agent = navigator.userAgent;
  const platform = platformOf(agent);
  return {
    kind: "browser",
    name: nameOf(agent, platform),
    platform,
    channel: import.meta.env.DEV ? "dev" : "stable",
    version: BUILD_VERSION,
  };
};

const isInstallation = Schema.is(Installation);

/**
 * This browser as an install, kept apart from the sign-in, which signing out forgets: signing in
 * again is still this browser, not another device. None when the browser keeps no site data.
 */
const thisInstallation = (): Installation | undefined => {
  try {
    const saved = localStorage.getItem(INSTALLATION_KEY);
    if (saved !== null && isInstallation(saved)) return saved;
    const fresh = randomToken(16);
    localStorage.setItem(INSTALLATION_KEY, fresh);
    return fresh;
  } catch {
    return undefined;
  }
};

/**
 * When the relay connection may have died unnoticed: iOS suspends a Home Screen app that leaves the
 * screen, and its socket often comes back open but dead; a network can also come back.
 */
const browserWakes = (check: () => void) => {
  const shown = () => {
    if (document.visibilityState === "visible") check();
  };
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("pageshow", check);
  window.addEventListener("online", check);
  return () => {
    document.removeEventListener("visibilitychange", shown);
    window.removeEventListener("pageshow", check);
    window.removeEventListener("online", check);
  };
};

const HANDED = /^#cerium-link=([A-Za-z0-9_-]{32,})\.([A-Za-z0-9_-]{32,})$/;

/**
 * The code Cerium's sign-in page sent this page back with, once the user confirmed in it, taken off
 * the URL so it's neither kept in history nor read twice. The page runs on this origin, so the code
 * reaches only this browser.
 */
const handedBack = (): HandedCode | undefined => {
  const match = HANDED.exec(location.hash);
  if (match === null) return undefined;
  history.replaceState(history.state, "", location.pathname + location.search);
  return { link: match[1]!, code: match[2]! };
};

/** The web client takes its code from the URL it was sent back to, once. */
const pageHandoff = (handed: HandedCode | undefined): LinkHandoff => {
  let left = handed;
  return {
    listen: () =>
      Effect.succeed({
        next: Effect.suspend(() => {
          const code = left;
          left = undefined;
          return code === undefined ? Effect.never : Effect.succeed(code);
        }),
      }),
  };
};

/**
 * This page as a device: `Account` and `CloudThreads`, on the relay that served it. Read from the page
 * only once built, which only the web client does.
 */
export const WebDevice = Layer.suspend(() =>
  CloudThreads.layer.pipe(
    Layer.provideMerge(
      Account.layer({
        relayUrl: location.origin,
        device: thisBrowser(),
        installation: thisInstallation(),
        wakes: browserWakes,
        handoff: pageHandoff(handedBack()),
      }),
    ),
    Layer.provide(browserVault),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  ),
);
