import { fork } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_RELAY_URL } from "@cerium/account";
import { parse, help } from "./args.ts";
import { manageService, serviceInstalled } from "./service.ts";

const root = resolve(import.meta.dirname, "..");
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const installRoot = process.env["CERIUM_HOST_INSTALL_ROOT"];

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.command === "help") return console.log(help);
  if (args.command === "version") return console.log(version);
  const channel =
    args.channel ?? (version.includes("-nightly.") ? "nightly" : version === "0.0.0" ? "dev" : "stable");
  const relayUrl = args.relayUrl ?? DEFAULT_RELAY_URL;
  const flags = [
    `--data-dir=${args.dataDirectory}`,
    `--relay-url=${relayUrl}`,
    `--channel=${channel}`,
    ...(args.name ? [`--name=${args.name}`] : []),
  ];
  if (args.command === "service") {
    const launcher = installRoot
      ? [
          join(installRoot, "runtime", process.platform === "win32" ? "node.exe" : "bin/node"),
          join(installRoot, "bin", "standalone.mjs"),
        ]
      : [process.execPath, join(root, "bin", "cerium-host.mjs")];
    manageService(args.action!, [...launcher, "run", ...flags], { follow: args.follow });
    if (args.action === "install") {
      const { status } = await import("./status.ts");
      const current = status(args.dataDirectory, relayUrl, true);
      console.log("Cerium Host service installed and started.");
      if (!current.signedIn) {
        console.warn(
          "Note: this host is not signed in yet. Run cerium-host service stop, cerium-host login, and cerium-host service start to link your account.",
        );
      } else {
        console.log("Check status with cerium-host status, or follow logs with cerium-host service logs -f.");
      }
    } else if (args.action !== "logs") {
      const labels = {
        uninstall: "Cerium Host service uninstalled.",
        start: "Cerium Host service started.",
        stop: "Cerium Host service stopped.",
        restart: "Cerium Host service restarted.",
      } as const;
      console.log(labels[args.action!]);
    }
  } else if (args.command === "update") {
    const { updateHost } = await import("./update.ts");
    await updateHost({
      installed: version,
      installRoot,
      version: args.version,
      channel: channel === "nightly" ? channel : "stable",
      check: args.check,
    });
  } else if (args.command === "status") {
    const { status } = await import("./status.ts");
    const state = status(args.dataDirectory, relayUrl, serviceInstalled());
    console.log(
      args.json
        ? JSON.stringify({ ...state, dataDirectory: args.dataDirectory }, null, 2)
        : [
            state.account,
            state.runtime
              ? `Host running (PID ${state.runtime.pid}, ${state.runtime.connection}).`
              : "Host stopped.",
            `Native service ${state.serviceInstalled ? "installed" : "not installed"}.\nData: ${args.dataDirectory}`,
          ].join("\n"),
    );
  } else if (args.command === "login" || args.command === "logout") {
    const { accountCommand } = await import("./account.ts");
    await accountCommand(args.command, { ...args, relayUrl, channel, version });
  } else {
    const { remoteUpdates, agentsWorking } = await import("./remoteUpdates.ts");
    const log = process.env["CERIUM_HOST_SERVICE_LOG"];
    const fd = log ? openSync(log, "a", 0o600) : undefined;
    const backend = fork(
      join(root, "dist", "backend.mjs"),
      [...flags, "--headless", `--app-version=${version}`, `--migrations-dir=${join(root, "migrations")}`],
      {
        execArgv: [],
        stdio: ["inherit", fd ?? "inherit", fd ?? "inherit", "ipc"],
        windowsHide: true,
      },
    );
    if (fd !== undefined) closeSync(fd);
    let stopping = false;
    let relaunch = false;
    const stop = () => {
      stopping = true;
      if (backend.connected) backend.send("stop", () => {});
    };
    let connection: { url: string; token: string } | undefined;
    const updates = remoteUpdates({
      root: installRoot,
      version,
      channel: channel === "nightly" ? channel : "stable",
      working: () => (connection ? agentsWorking(connection) : Promise.resolve(true)),
      restart: () => {
        relaunch = true;
        stop();
      },
      send: (updates) => {
        if (backend.connected) backend.send({ type: "desktopUpdateState", updates }, () => {});
      },
    });
    backend.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "url" in message &&
        typeof message.url === "string" &&
        "token" in message &&
        typeof message.token === "string"
      ) {
        connection = { url: message.url, token: message.token };
      } else void updates.receive(message).catch((error) => console.error(error));
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    backend.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    backend.once("exit", (code, signal) => {
      void updates.close().catch((error) => console.error(error));
      process.exitCode = relaunch ? 75 : stopping ? 0 : (code ?? (signal ? 1 : 0));
    });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
