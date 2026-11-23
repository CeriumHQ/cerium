import { Account, AccountError } from "@cerium/account";
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
  readSavedSignIn,
  savedStatus,
  terminalLines,
} from "@cerium/backend/headless";
import { fileVault } from "@cerium/backend/vault";

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
  const account = Account.layer({
    relayUrl: options.relayUrl,
    device: thisMachine(options.channel, options.version, { name: options.name, headless: true }),
    installation: thisInstallation(options.dataDirectory),
    connect: false,
    handoff: manual ? manualHandoff() : headlessHandoff(terminalLines),
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
    const { url } = yield* service.signIn;
    if (URL.parse(url)?.origin !== new URL(options.relayUrl).origin)
      return yield* new AccountError({ message: "The sign-in URL is outside this relay." });
    console.log(`Open this page to link your host:\n\n${url}\n`);
    console.log(
      manual
        ? "Paste the confirmation code or callback URL here and press Enter."
        : "The browser will return to this host. You can also paste its callback URL here and press Enter.",
    );
    if (!manual) openBrowser(url);
    const result = Option.getOrUndefined(
      yield* service.changes.pipe(
        Stream.filter((state) => state._tag !== "SigningIn"),
        Stream.runHead,
      ),
    );
    if (result?._tag !== "SignedIn")
      return yield* new AccountError({
        message: result?.error ?? "Sign-in ended before the host was linked.",
      });
    console.log(`Signed in as ${result.account.email ?? result.account.name ?? result.account.id}.`);
  });
  await Effect.runPromise(action.pipe(Effect.provide(account)));
}
