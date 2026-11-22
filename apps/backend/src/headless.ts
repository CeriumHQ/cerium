import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { Account, type HandedCode, type LinkHandoff } from "@cerium/account";
import {
  AccountProfile,
  DeviceId,
  LINK_CALLBACK_PATH,
  LinkCode,
  LinkId,
  type AccountState,
} from "@cerium/protocol";
import { Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { loopbackHandoff } from "./linkHandoff.ts";

// The backend on its own, with no desktop app around it: a Mac mini in a cupboard, a home server, a
// VPS. It says in the terminal how its account stands, signs in from there with `--sign-in`, and
// `--status` says how the saved sign-in stands without starting anything.

export interface HeadlessFlags {
  /** Sign this machine in, waiting for the user to confirm in a browser. */
  readonly signIn: boolean;
  /** Say how the saved sign-in stands, and exit. */
  readonly status: boolean;
}

export const headlessFlags = (argv: ReadonlyArray<string>): HeadlessFlags => ({
  signIn: argv.includes("--sign-in"),
  status: argv.includes("--status"),
});

const who = (profile: AccountProfile) => profile.email ?? profile.name ?? profile.id;

const connectionWord = { connecting: "connecting", online: "online", offline: "offline, retrying" } as const;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export interface DescribeOptions {
  /** This machine's name, until the account says what it's called there. */
  readonly deviceName: string;
  /** The loopback port the sign-in page hands the code to, for an SSH tunnel. */
  readonly port?: number | undefined;
  /** Whether the address the page lands on can be pasted here. */
  readonly paste?: boolean;
}

/** How the account stands, as the terminal says it. */
export const describeAccount = (state: AccountState, options: DescribeOptions): string => {
  switch (state._tag) {
    case "SignedOut":
      return state.error === undefined
        ? `Not signed in. Run with --sign-in to link ${options.deviceName} to your account.`
        : `Not signed in. ${state.error}`;
    case "SigningIn":
      return [
        `Sign in to link ${options.deviceName}. Open this page in any browser:`,
        "",
        `    ${state.url}`,
        "",
        ...(options.paste
          ? [
              "No browser on this machine? Once you confirm, the page goes to a 127.0.0.1 address",
              "that won't load. Paste that address here.",
            ]
          : []),
        ...(options.port === undefined
          ? []
          : [`Or tunnel it first: ssh -L ${options.port}:127.0.0.1:${options.port} <this machine>`]),
        `The link expires at ${clock(state.expiresAt)}.`,
      ].join("\n");
    case "SignedIn": {
      const name = state.devices.find((device) => device.id === state.deviceId)?.name ?? options.deviceName;
      return `Signed in as ${who(state.account)} on ${name}, ${connectionWord[state.connection]}.`;
    }
  }
};

const isLinkId = Schema.is(LinkId);
const isCode = Schema.is(LinkCode);

/** The code in the address the sign-in page sent the browser to, pasted into the terminal. */
export const pastedCode = (line: string): HandedCode | undefined => {
  let url: URL;
  try {
    url = new URL(line.trim());
  } catch {
    return undefined;
  }
  const link = url.searchParams.get("link");
  const code = url.searchParams.get("code");
  return url.pathname === LINK_CALLBACK_PATH && isLinkId(link) && isCode(code) ? { link, code } : undefined;
};

/**
 * The loopback handoff, which also takes the address the page landed on pasted into the terminal,
 * for a machine whose browser is elsewhere. Pasting it is the user's own act at this machine, as
 * opening the page on it is. `listening` hears the port it waits on.
 */
export const headlessHandoff = (
  lines: (onLine: (line: string) => void) => () => void,
  listening: (port: number | undefined) => void = () => {},
): LinkHandoff => ({
  listen: (options) =>
    Effect.gen(function* () {
      const loopback = yield* loopbackHandoff.listen(options);
      const pasted = yield* Queue.unbounded<HandedCode>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          lines((line) => {
            const handed = pastedCode(line);
            if (handed !== undefined) Queue.offerUnsafe(pasted, handed);
          }),
        ),
        (stop) => Effect.sync(stop),
      );
      listening(loopback.callback?.port);
      return {
        ...(loopback.callback === undefined ? {} : { callback: loopback.callback }),
        next: Effect.race(loopback.next, Queue.take(pasted)),
      };
    }),
});

/** The terminal's lines, for as long as they're wanted. Ctrl-C still stops the backend. */
export const terminalLines = (onLine: (line: string) => void) => {
  const reader = createInterface({ input: process.stdin, terminal: false });
  reader.on("line", onLine);
  return () => reader.close();
};

/**
 * Says how the account stands whenever that changes, and with `signIn` starts signing in: once at
 * startup, and again when a link expires unconfirmed.
 */
export const watchAccount = (options: {
  readonly signIn: boolean;
  readonly describe: Omit<DescribeOptions, "port">;
  readonly port?: () => number | undefined;
  readonly print?: (text: string) => void;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const account = yield* Account;
      const print = options.print ?? ((text: string) => void process.stdout.write(`\n${text}\n\n`));
      let said: string | undefined;
      let previous: AccountState["_tag"] | undefined;
      const signIn = account.signIn.pipe(
        Effect.catch((error) => Effect.sync(() => print(`Couldn't start signing in. ${error.message}`))),
      );
      yield* account.changes.pipe(
        Stream.runForEach((state) =>
          Effect.gen(function* () {
            const text = describeAccount(state, { ...options.describe, port: options.port?.() });
            if (text !== said) print(text);
            said = text;
            const ask =
              options.signIn &&
              state._tag === "SignedOut" &&
              (previous === undefined || previous === "SigningIn");
            previous = state._tag;
            if (ask) yield* signIn;
          }),
        ),
        Effect.forkScoped,
      );
    }),
  );

const SavedSignIn = Schema.Union([
  Schema.Struct({ relayUrl: Schema.String, account: AccountProfile, deviceId: DeviceId }),
  Schema.Struct({
    _tag: Schema.Literal("Pending"),
    relayUrl: Schema.String,
    link: Schema.Struct({ url: Schema.String, expiresAt: Schema.Finite }),
  }),
]);
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedSignIn));

/** How a development or headless backend's saved sign-in stands, read from its file. */
export const savedStatus = (
  contents: string | undefined,
  options: { readonly relayUrl: string; readonly deviceName: string; readonly now?: number },
): { readonly signedIn: boolean; readonly text: string } => {
  const notSignedIn = `Not signed in. Run with --sign-in to link ${options.deviceName} to your account.`;
  if (contents === undefined) return { signedIn: false, text: notSignedIn };
  const saved = Option.getOrUndefined(decodeSaved(contents));
  if (saved === undefined)
    return { signedIn: false, text: "The saved sign-in couldn't be read. Sign in again." };
  if (saved.relayUrl !== options.relayUrl)
    return { signedIn: false, text: `Signed in to another relay (${saved.relayUrl}). Sign in again here.` };
  if ("_tag" in saved)
    return saved.link.expiresAt > (options.now ?? Date.now())
      ? { signedIn: false, text: `Waiting for sign-in at ${saved.link.url}` }
      : { signedIn: false, text: notSignedIn };
  return {
    signedIn: true,
    text: `Signed in as ${who(saved.account)} on ${options.deviceName} (device ${saved.deviceId}).`,
  };
};

/** Reads the saved sign-in from `file`; a sign-in the desktop app keeps encrypted isn't there. */
export const readSavedSignIn = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
