import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ServiceAction } from "./args.ts";

const unit = "cerium-host.service";
const label = "app.cerium.host";
const task = "Cerium Host";
const folder = join(homedir(), ".cerium-service");
const logfile = join(folder, "host.log");
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const unitFile = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "systemd", "user", unit);
const windowsScript = join(folder, "service.vbs");

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unitArg = (value: string) =>
  '"' +
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$") +
  '"';

export function systemdDefinition(argv: string[], path: string) {
  // ExecStart expands dollar-prefixed variables. Environment= only expands specifiers.
  return `[Unit]
Description=Cerium host
After=network-online.target

[Service]
Type=simple
ExecStart=${argv.map(unitArg).join(" ")}
Environment=${unitArg("PATH=" + path).replaceAll("$$", () => "$")}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function launchdDefinition(argv: string[], path: string, log: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argv.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

const winArg = (arg: string) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
const vb = (s: string) => '"' + s.replaceAll('"', '""') + '"';

export function windowsDefinition(argv: string[], log: string, script: string, userSid: string) {
  // WScript launches Node hidden and waits so Task Scheduler can track and restart the host.
  const vbs = `Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")
env("CERIUM_HOST_SERVICE_LOG") = ${vb(log)}
env("CERIUM_HOST_SERVICE_COMMAND") = ${vb(argv.map(winArg).join(" "))}
WScript.Quit shell.Run("%CERIUM_HOST_SERVICE_COMMAND%", 0, True)
`;
  const sid = xml(userSid);
  const definition = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Host"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Host"><Exec><Command>wscript.exe</Command><Arguments>//B //Nologo ${xml(winArg(script))}</Arguments></Exec></Actions>
</Task>
`;
  return { vbs, definition };
}

function run(command: string, args: string[], allowFailure = false, inherit = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: inherit ? "inherit" : "pipe",
  });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new Error(
      result.error?.message || result.stderr?.trim() || `${command} exited with ${result.status}.`,
    );
  return result;
}

export function serviceInstalled() {
  if (process.platform === "linux") return existsSync(unitFile);
  if (process.platform === "darwin") return existsSync(plist);
  if (process.platform === "win32") return run("schtasks", ["/Query", "/TN", task], true).status === 0;
  return false;
}

export function manageService(
  action: ServiceAction,
  argv: string[] = [],
  options: { readonly follow?: boolean } = {},
) {
  const follow = options.follow === true;
  if ((action === "start" || action === "stop" || action === "restart") && !serviceInstalled())
    throw new Error("Cerium Host service is not installed. Run cerium-host service install first.");
  if (process.platform === "linux") {
    const systemctl = (args: string[]) => run("systemctl", ["--user", ...args]);
    if (action === "install") {
      mkdirSync(dirname(unitFile), { recursive: true });
      writeFileSync(unitFile, systemdDefinition(argv, process.env["PATH"] ?? ""), { mode: 0o600 });
      systemctl(["daemon-reload"]);
      systemctl(["enable", unit]);
      systemctl(["restart", unit]);
      const user = userInfo().username;
      if (run("loginctl", ["enable-linger", user], true).status !== 0)
        console.warn(
          `Host started. For operation after logout, ask an administrator to run loginctl enable-linger ${user}.`,
        );
    } else if (action === "uninstall") {
      if (!serviceInstalled()) return;
      systemctl(["disable", "--now", unit]);
      rmSync(unitFile);
      systemctl(["daemon-reload"]);
    } else if (action === "logs")
      run(
        "journalctl",
        ["--user", "-u", unit, "-n", "100", ...(follow ? ["-f"] : ["--no-pager"])],
        false,
        true,
      );
    else systemctl([action, unit]);
  } else if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    const address = `${domain}/${label}`;
    const loaded = () => run("launchctl", ["print", address], true).status === 0;
    const unload = () => {
      if (loaded()) run("launchctl", ["bootout", address]);
    };
    if (action === "install") {
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      unload();
      writeFileSync(plist, launchdDefinition(argv, process.env["PATH"] ?? "", logfile), { mode: 0o600 });
      run("launchctl", ["enable", address]);
      run("launchctl", ["bootstrap", domain, plist]);
    } else if (action === "uninstall") {
      unload();
      rmSync(plist, { force: true });
    } else if (action === "stop") unload();
    else if (action === "logs") {
      if (!existsSync(logfile)) return console.log(`No service logs yet at ${logfile}.`);
      run("tail", ["-n", "100", ...(follow ? ["-f"] : []), logfile], false, true);
    } else if (!loaded()) run("launchctl", ["bootstrap", domain, plist]);
    else if (action === "restart") run("launchctl", ["kickstart", "-k", address]);
  } else if (process.platform === "win32") {
    const schedule = (args: string[], allowFailure = false) =>
      run("schtasks", [...args, "/TN", task], allowFailure);
    if (action === "install") {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const sid = run("whoami", ["/user", "/fo", "csv", "/nh"]).stdout.match(/S-1-[\d-]+/i)?.[0];
      if (!sid) throw new Error("Couldn't identify the user for the scheduled task.");
      const def = windowsDefinition(argv, logfile, windowsScript, sid);
      writeFileSync(windowsScript, "\uFEFF" + def.vbs, "utf16le");
      const config = join(folder, "task.xml");
      writeFileSync(config, "\uFEFF" + def.definition, "utf16le");
      if (serviceInstalled()) schedule(["/End"], true);
      schedule(["/Create", "/XML", config, "/F"]);
      schedule(["/Run"]);
    } else if (action === "uninstall") {
      if (serviceInstalled()) {
        schedule(["/End"], true);
        schedule(["/Delete", "/F"]);
      }
      rmSync(windowsScript, { force: true });
      rmSync(join(folder, "task.xml"), { force: true });
    } else if (action === "logs") {
      if (!existsSync(logfile)) return console.log(`No service logs yet at ${logfile}.`);
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-Content -LiteralPath '${logfile.replaceAll("'", "''")}' -Tail 100${follow ? " -Wait" : ""}`,
        ],
        false,
        true,
      );
    } else {
      if (action === "stop" || action === "restart") schedule(["/End"], action === "restart");
      if (action === "start" || action === "restart") schedule(["/Run"]);
    }
  } else throw new Error(`No native service manager for ${process.platform}.`);
}
