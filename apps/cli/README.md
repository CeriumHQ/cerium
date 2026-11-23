# Cerium Host

Run Cerium on a workstation, home server or VPS and select it in your Cerium account. Install the agent CLIs you want to use and sign in to them as the same OS user that runs this host.

## Install

Install from npm with Node 24.11 or later.

```sh
npm install -g @cerium/host
cerium-host login --name "Home server"
cerium-host service install
cerium-host status
```

The standalone GitHub release archives include Node. Verify the archive against its matching `.sha256` file, extract it in a persistent directory and add its `bin` directory to PATH. The binary is `cerium-host.cmd` on Windows.

Use `cerium-host login --no-browser` to sign in from another computer. Open the printed URL, confirm the device and paste the code into the original terminal. SSH sessions select this flow automatically. A local graphical session opens a browser and listens for its callback on loopback.

## Run and manage the host

```sh
cerium-host run --data-dir ~/.cerium-host --name "Build machine"
cerium-host service install --data-dir ~/.cerium-host
cerium-host status --data-dir ~/.cerium-host --json
cerium-host service logs
cerium-host service restart
cerium-host service stop
cerium-host service start
cerium-host service uninstall
cerium-host logout --data-dir ~/.cerium-host
```

Stop the host before changing its saved account, then start it again. Use the same data directory for sign-in and the daemon. The default is `~/.cerium`. Install and run under your own user account. Linux uses a systemd user unit and requests lingering for startup at boot. macOS uses a per-user LaunchAgent and Windows uses a scheduled task at user logon. Both need a signed-in OS session. Run the foreground command under your container's supervisor for a container installation.

`cerium-host update --check` checks GitHub Releases. Standalone installs use `cerium-host update` to verify the archive digest, activate the new version and restart an installed service. A manually started foreground process picks up the release the next time it starts. Use `--channel nightly` or select a specific release with `--version`. For npm installs, the command prints the npm upgrade command. From a connected Cerium device, you can also check and apply a standalone host update in Settings → Updates. The host restarts after its agents finish and you confirm the update. Run `cerium-host --help` for the full command list.

## Build from this checkout

```sh
bun run build:cli
bun run package:cli -- --target=linux-x64 --version=1.2.3 --out=./out
CERIUM_VERSION=1.2.3 bun run --cwd apps/cli build:npm
npm pack ./apps/cli/out/npm
```

The npm staging directory contains the bundled JavaScript, SQL migrations, license, and patched node-pty dependency. To publish that prepared directory use `npm publish ./apps/cli/out/npm --access public`.
