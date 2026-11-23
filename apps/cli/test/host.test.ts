import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { parse } from "../src/args.ts";
import { isValidPastedInput, manualLogin } from "../src/account.ts";
import { hostStatus } from "../src/status.ts";
import { launchdDefinition, systemdDefinition, windowsDefinition } from "../src/service.ts";
import { archiveName, compareVersions, releaseVersion, target, targets } from "../src/release.ts";
import { updateAvailable } from "../src/update.ts";
import { checksum } from "../src/download.ts";
import { keepDependency } from "../scripts/stage.ts";

describe("command line", () => {
  it("accepts split and equals forms and normalizes relay and data directory", () => {
    expect(
      parse([
        "login",
        "--name=Office",
        "--no-browser",
        "--data-dir",
        "host data",
        "--relay-url",
        "https://relay.example/",
      ]),
    ).toMatchObject({
      command: "login",
      name: "Office",
      noBrowser: true,
      dataDirectory: join(process.cwd(), "host data"),
      relayUrl: "https://relay.example",
    });
    expect(parse(["service", "install", "--name", "My host"])).toMatchObject({
      action: "install",
      name: "My host",
    });
    expect(parse(["update", "--version", "v2.0.0", "--check"])).toMatchObject({
      version: "v2.0.0",
      check: true,
    });
    expect(parse(["service", "logs", "-f"])).toMatchObject({ action: "logs", follow: true });
    expect(parse(["service", "logs", "--follow"])).toMatchObject({ action: "logs", follow: true });
    expect(parse(["--version"])).toEqual({ command: "version" });
    expect(parse(["-v"])).toEqual({ command: "version" });
    expect(parse(["version"])).toEqual({ command: "version" });
    expect(parse(["help"])).toEqual({ command: "help" });
  });
  it("rejects unknown or misplaced options and service actions", () => {
    for (const argv of [
      ["service"],
      ["service", "delete"],
      ["service", "start", "--follow"],
      ["run", "--json"],
      ["update", "--channel=dev"],
      ["login", "--relay-url=file:///etc"],
      ["login", "--name=a\nb"],
    ])
      expect(() => parse(argv)).toThrow(
        /service action|Unknown option|Unsupported channel|relay-url|Invalid value|--follow/i,
      );
  });
  it("validates pasted confirmation codes and callback URLs", () => {
    const token = "a".repeat(40);
    expect(isValidPastedInput(token, true)).toBe(true);
    expect(isValidPastedInput(token, false)).toBe(false);
    expect(isValidPastedInput("not a code", true)).toBe(false);
    expect(isValidPastedInput(`http://127.0.0.1:4321/cerium/link?link=${token}&code=${token}`, false)).toBe(
      true,
    );
  });
  it("uses the manual handoff on SSH and when a browser is unavailable", () => {
    expect(manualLogin(false, { SSH_TTY: "tty" }, "darwin")).toBe(true);
    expect(manualLogin(false, {}, "linux")).toBe(true);
    expect(manualLogin(false, { WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(manualLogin(true, {}, "win32")).toBe(true);
  });
});

describe("native services", () => {
  const argv = ["/my host/node", "run", '--name=50% $USER <A&B> "office"'];
  it("preserves literal systemd arguments and the restart interval", () => {
    const unit = systemdDefinition(argv, "/home/u/$bin");
    expect(unit).toContain('ExecStart="/my host/node" "run" "--name=50%% $$USER <A&B> \\"office\\""');
    expect(unit).toContain('Environment="PATH=/home/u/$bin"');
    expect(unit).toContain("Restart=always\nRestartSec=5");
  });
  it("quotes LaunchAgent arguments as XML and enables keep-alive", () => {
    const plist = launchdDefinition(argv, "/bin", "/home/log");
    expect(plist).toContain("<string>--name=50% $USER &lt;A&amp;B&gt; &quot;office&quot;</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
  });
  it("sets a per-user logon trigger and hides the Windows launcher", () => {
    const { definition, vbs } = windowsDefinition(
      argv,
      "C:\\log",
      "C:\\my host\\service.vbs",
      "S-1-5-21-123",
    );
    expect(definition).toContain("<LogonTrigger>");
    expect(definition).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(definition).toContain("C:\\my host\\service.vbs");
    expect(vbs).toContain('shell.Run("%CERIUM_HOST_SERVICE_COMMAND%", 0, True)');
    expect(vbs).toContain("CERIUM_HOST_SERVICE_LOG");
  });
});

describe("status", () => {
  const relay = "https://relay.example";
  const saved = JSON.stringify({
    relayUrl: relay,
    account: { id: "fred", name: "Fred" },
    deviceId: "dev-1",
    credential: "keep-secret",
  });
  it("reports credentials, service installation and connectivity independently", () => {
    expect(hostStatus(saved, undefined, relay, true)).toMatchObject({
      signedIn: true,
      running: false,
      online: false,
      serviceInstalled: true,
    });
    const live = hostStatus(
      saved,
      { pid: 42, startedAt: 10, name: "Office", version: "1.0.0", connection: "online" },
      relay,
      false,
    );
    expect(live).toMatchObject({ signedIn: true, running: true, online: true, serviceInstalled: false });
    expect(JSON.stringify(live)).not.toContain("keep-secret");
    expect(hostStatus(saved, undefined, "https://other", false).signedIn).toBe(false);
  });
});

describe("release archives and updates", () => {
  it("uses the release channel's numeric version order, including old nightly tags", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0-nightly.n000010", "1.10.0-nightly.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.10.0-nightly.n009999")).toBeGreaterThan(0);
    expect(updateAvailable("1.2.0", "1.1.0", false)).toBe(false);
    expect(updateAvailable("1.2.0", "1.1.0", true)).toBe(true);
    expect(() => releaseVersion("../latest")).toThrow(/Invalid Cerium release/);
  });
  it("maps each target to exactly one release archive and digest", () => {
    for (const t of targets) {
      const asset = archiveName("v1.2.3", t);
      expect(asset).toBe(`cerium-host-1.2.3-${t}` + (t.startsWith("win32-") ? ".zip" : ".tar.gz"));
      const hash = "ab".repeat(32);
      expect(checksum(`${hash}  ${asset}\r\n`, asset)).toBe(hash);
      expect(() => checksum(`${hash}  other`, asset)).toThrow(/Missing SHA-256/);
    }
    expect(() => target("linux-s390x")).toThrow(/Unsupported host target/);
  });
  it("keeps runtime bindings while dropping other targets, source and bundled agent tools", () => {
    const keep = (path: string) => keepDependency(join("node_modules", ...path.split("/")), "darwin-arm64");
    expect(keep("node-pty/prebuilds/darwin-arm64/pty.node")).toBe(true);
    expect(keep("node-pty/prebuilds/win32-x64/pty.node")).toBe(false);
    expect(keep("@cursor/sdk/dist/esm/index.js")).toBe(true);
    expect(keep("@cursor/sdk/dist/bundled/index.js")).toBe(false);
    expect(keep("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).toBe(false);
    expect(keep("effect/dist/foo.d.ts")).toBe(false);
  });
});
