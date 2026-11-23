import { Account, AccountError } from "@cerium/account";
import { LinkCode } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";
import { spawn } from "node:child_process";
import { acquireDataLock, readRuntimeStatus } from "@cerium/backend/runtime";
import { join } from "node:path";
import { thisInstallation, thisMachine } from "@cerium/backend/device";
import {
  headlessHandoff,
  manualHandoff,
  pastedCode,
  readSavedSignIn,
  savedStatus,
  terminalLines,
} from "@cerium/backend/headless";
import { fileVault } from "@cerium/backend/vault";
import { serviceInstalled } from "./service.ts";

const isLinkCode = Schema.is(LinkCode);

export function isValidPastedInput(line: string, manual: boolean) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (manual && isLinkCode(trimmed)) return true;
  return pastedCode(trimmed) !== undefined;
}

function feedbackLines(manual: boolean): typeof terminalLines {
  return (onLine) =>
    terminalLines((line) => {
      if (!line.trim()) {
        if (manual && process.stdin.isTTY) process.stdout.write("Confirmation code: ");
        return;
      }
      if (!isValidPastedInput(line, manual)) {
        process.stderr.write(
          manual
            ? "That doesn't look like a confirmation code. Paste the code from the sign-in page and press Enter.\n"
            : "That doesn't look like a Cerium callback URL. Paste the full 127.0.0.1 URL from your browser and press Enter.\n",
        );
        if (manual && process.stdin.isTTY) process.stdout.write("Confirmation code: ");
        return;
      }
      onLine(line);
    });
}

export function manualLogin(noBrowser: boolean, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return (
    noBrowser ||
    Boolean(env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"]) ||
    (platform === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"])
  );
}

function openBrowser(url: string) {
  const [command, args] =
    process.platform === "win32"
      ? (["rundll32", ["url.dll,FileProtocolHandler", url]] as const)
      : process.platform === "darwin"
        ? (["open", [url]] as const)
        : (["xdg-open", [url]] as const);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => console.error("Open the sign-in URL above in your browser."));
  child.unref();
}

interface AccountCommandOptions {
  dataDirectory: string;
  relayUrl: string;
  name: string | undefined;
  channel: "stable" | "nightly" | "dev";
  version: string;
  noBrowser: boolean;
}

export async function accountCommand(command: "login" | "logout", options: AccountCommandOptions) {
  const runtime = readRuntimeStatus(options.dataDirectory);
  if (runtime) {
    if (command === "login") {
      const saved = savedStatus(readSavedSignIn(join(options.dataDirectory, "account.json")), {
        deviceName: runtime.name,
        relayUrl: options.relayUrl,
      });
      if (saved.signedIn) return console.log(saved.text);
    }
    throw new Error(
      `Host PID ${runtime.pid} is using this data directory. Stop the foreground host or run cerium-host service stop, then run ${command} and start the host again.`,
    );
  }
  const lock = acquireDataLock(options.dataDirectory);
  try {
    await changeAccount(command, options);
  } finally {
    lock.release();
  }
}

async function changeAccount(command: "login" | "logout", options: AccountCommandOptions) {
  const vaultPath = join(options.dataDirectory, "account.json");
  const saved = readSavedSignIn(vaultPath);
  const savedRelay = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ relayUrl: Schema.String })),
  );
  const previous = Option.getOrUndefined(savedRelay(saved));
  if (previous && previous.relayUrl !== options.relayUrl)
    throw new Error("This data directory belongs to another relay. Use its --relay-url to sign out first.");
  const manual = manualLogin(options.noBrowser, process.env, process.platform);
  const lines = feedbackLines(manual);
  const account = Account.layer({
    relayUrl: options.relayUrl,
    device: thisMachine(options.channel, options.version, { name: options.name, headless: true }),
    installation: thisInstallation(options.dataDirectory),
    connect: false,
    handoff: manual ? manualHandoff(lines) : headlessHandoff(lines),
  }).pipe(
    Layer.provide(fileVault(vaultPath)),
    Layer.provide(NodeServices.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

  const action = Effect.gen(function* () {
    const service = yield* Account;
    if (command === "logout") {
      yield* service.signOut;
      console.log("Signed out.");
      return;
    }
    const current = Option.getOrUndefined(yield* Stream.runHead(service.changes));
    if (current?._tag === "SignedIn") {
      console.log(
        `Already signed in as ${current.account.email ?? current.account.name ?? current.account.id}.`,
      );
      return;
    }
    let cancelled = false;
    const runWithContext = Effect.runPromiseWith(yield* Effect.context<never>());
    const cancel = () => {
      cancelled = true;
      void runWithContext(service.cancelSignIn);
    };
    process.once("SIGINT", cancel);
    try {
      const { url } = yield* service.signIn;
      if (URL.parse(url)?.origin !== new URL(options.relayUrl).origin)
        return yield* new AccountError({ message: "The sign-in URL is outside this relay." });
      console.log(`Open this page to link your host:\n\n  ${url}\n`);
      console.log(
        manual
          ? "After confirming in your browser, paste the confirmation code here and press Enter."
          : "Your browser will return to this host automatically. You can also paste its callback URL here.",
      );
      if (manual && process.stdin.isTTY) process.stdout.write("Confirmation code: ");
      if (!manual) openBrowser(url);
      const result = Option.getOrUndefined(
        yield* service.changes.pipe(
          Stream.filter((state) => state._tag !== "SigningIn"),
          Stream.runHead,
        ),
      );
      if (cancelled) {
        if (manual && process.stdin.isTTY) process.stdout.write("\n");
        console.log("Sign-in cancelled.");
        return;
      }
      if (result?._tag !== "SignedIn")
        return yield* new AccountError({
          message: result?.error ?? "Sign-in ended before the host was linked.",
        });
      console.log(`Signed in as ${result.account.email ?? result.account.name ?? result.account.id}.`);
      console.log(
        serviceInstalled()
          ? "Next: run cerium-host service start to bring this host online."
          : "Next: run cerium-host service install to keep this host online 24/7 (or cerium-host run in the foreground).",
      );
    } finally {
      process.off("SIGINT", cancel);
    }
  });
  await Effect.runPromise(action.pipe(Effect.provide(account)));
}
