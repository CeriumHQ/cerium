import { beforeEach, describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import { vi } from "vite-plus/test";

type Listener = () => void;
const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  power: new Map<string, Listener>(),
  onBattery: false,
  blockers: new Set<number>(),
  nextBlocker: 1,
  tooltip: "",
  menu: [] as Array<{
    label?: string;
    submenu?: Array<{ label: string; checked: boolean; click: () => void }>;
  }>,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "user", on() {}, quit() {} },
  BrowserWindow: { getFocusedWindow: () => null },
  Menu: { buildFromTemplate: (template: typeof fake.menu) => template },
  Notification: { isSupported: () => false },
  powerMonitor: {
    isOnBatteryPower: () => fake.onBattery,
    on: (event: string, listener: Listener) => fake.power.set(event, listener),
  },
  powerSaveBlocker: {
    start: () => {
      const id = fake.nextBlocker++;
      fake.blockers.add(id);
      return id;
    },
    stop: (id: number) => fake.blockers.delete(id),
  },
  Tray: class {
    setToolTip(text: string) {
      fake.tooltip = text;
    }
    setContextMenu(menu: typeof fake.menu) {
      fake.menu = menu;
    }
    on() {}
    destroy() {}
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => fake.files.has(path),
  readFileSync: (path: string) => {
    const value = fake.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  },
  writeFileSync: (path: string, value: string) => fake.files.set(path, value),
}));

const FILE = join("user", "keep-awake");
const { backgroundMode, isAttended, IDLE_AWAY_SECONDS, keepsAwake } = await import("../src/background.ts");

const mode = () => backgroundMode({ icon: "icon.png", window: () => undefined, show: () => {} });
const awake = () => fake.blockers.size > 0;

beforeEach(() => {
  fake.files.clear();
  fake.power.clear();
  fake.onBattery = false;
  fake.blockers.clear();
  fake.tooltip = "";
  fake.menu = [];
});

describe("keeping awake", () => {
  it("keeps a signed-in machine awake while agents work, plugged in, or always, as chosen", () => {
    const at = (state: Partial<Parameters<typeof keepsAwake>[0]>) =>
      keepsAwake({ signedIn: true, working: false, mode: "working", onBattery: false, ...state });
    expect(at({})).toBe(false);
    expect(at({ working: true })).toBe(true);
    expect(at({ working: true, onBattery: true })).toBe(true);
    expect(at({ mode: "ac" })).toBe(true);
    expect(at({ mode: "ac", onBattery: true })).toBe(false);
    expect(at({ mode: "always", onBattery: true })).toBe(true);
    expect(at({ mode: "always", signedIn: false, working: true })).toBe(false);
  });

  it("follows the saved setting, the power source and the tray, and says so in the tooltip", () => {
    fake.files.set(FILE, "ac");
    const background = mode();
    expect(background.keepAwake()).toBe("ac");
    background.setSignedIn(true);
    expect(awake()).toBe(true);
    expect(fake.tooltip).toBe("Cerium · staying awake for your other devices");

    fake.power.get("on-battery")!();
    expect(awake()).toBe(false);
    expect(fake.tooltip).toBe("Cerium · reachable from your other devices");
    background.setWorking(true);
    expect(awake()).toBe(true);
    background.setWorking(false);

    const choices = fake.menu.find((item) => item.label === "Keep awake")!.submenu!;
    expect(choices.map((each) => [each.label, each.checked])).toEqual([
      ["While agents work", false],
      ["While plugged in", true],
      ["Always", false],
    ]);
    choices.find((each) => each.label === "Always")!.click();
    expect(awake()).toBe(true);
    expect(fake.files.get(FILE)).toBe("always");
    expect(background.keepAwake()).toBe("always");

    background.setSignedIn(false);
    expect(awake()).toBe(false);
  });

  it("starts out keeping awake only while agents work", () => {
    fake.files.set(FILE, "nonsense");
    const background = mode();
    expect(background.keepAwake()).toBe("working");
    background.setSignedIn(true);
    expect(awake()).toBe(false);
    expect(fake.tooltip).toBe("Cerium · reachable from your other devices");
  });

  it("does not keep a hidden tray process or intercept window close while attached to cerium-host", () => {
    let hidden = false;
    const background = backgroundMode({
      icon: "icon.png",
      window: () => ({ hide: () => (hidden = true) }) as never,
      show: () => {},
    });
    fake.files.set(FILE, "always");
    background.setSignedIn(true);
    expect(awake()).toBe(true);
    expect(background.interceptClose()).toBe(true);
    expect(hidden).toBe(true);

    hidden = false;
    background.setAttached(true);
    expect(background.attached()).toBe(true);
    expect(awake()).toBe(false);
    expect(background.interceptClose()).toBe(false);
    expect(hidden).toBe(false);

    // Leaving attach mode explicitly restores tray & keep-awake behavior.
    background.setAttached(false);
    expect(background.attached()).toBe(false);
    expect(awake()).toBe(true);
    expect(background.interceptClose()).toBe(true);
  });
});

describe("whether the user is at Cerium", () => {
  it("needs a focused window, an unlocked screen and recent activity", () => {
    expect(isAttended({ focused: true, locked: false, idleSeconds: 3 })).toBe(true);
    expect(isAttended({ focused: false, locked: false, idleSeconds: 0 })).toBe(false);
    expect(isAttended({ focused: true, locked: true, idleSeconds: 0 })).toBe(false);
    expect(isAttended({ focused: true, locked: false, idleSeconds: IDLE_AWAY_SECONDS })).toBe(false);
  });
});
