import { CdpError } from "./cdp.ts";
import type { Page, Target } from "./page.ts";
import { fromJson, runStep, type Action } from "./steps.ts";
import { previewUrl } from "./url.ts";

// What an agent asks of the browser it shares with the user through Cerium's bus, and what it reads
// back: plain text, and a screenshot when it asked for one. The desktop shell runs these on a
// thread's preview page; the bus tools only carry them.

/** The steps `browser_act` takes, each as `bun run ui act`'s JSON steps are written. */
export const AGENT_ACTIONS = [
  "click",
  "doubleClick",
  "rightClick",
  "hover",
  "type",
  "fill",
  "press",
  "scroll",
  "drag",
  "wait",
  "waitGone",
  "sleep",
] as const satisfies ReadonlyArray<Action>;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface AgentTarget {
  readonly text?: string | undefined;
  readonly selector?: string | undefined;
  readonly nth?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export interface AgentStep extends AgentTarget {
  readonly action: AgentAction;
  /** type/fill: the text; press: the keys; scroll: pixels down (negative goes up). */
  readonly value?: string | undefined;
  /** drag: where to drop. */
  readonly to?: AgentTarget | undefined;
  /** wait/waitGone: how long to wait; sleep: how long to pause. */
  readonly ms?: number | undefined;
}

export type BrowserCommand =
  /** Opens `url`, or goes back, forward or reloads; with neither, just reports the page. */
  | { readonly _tag: "Open"; readonly url?: string; readonly go?: "back" | "forward" | "reload" }
  | { readonly _tag: "Read"; readonly text: boolean }
  | { readonly _tag: "Act"; readonly steps: ReadonlyArray<AgentStep>; readonly screenshot: boolean }
  | { readonly _tag: "Screenshot"; readonly fullPage: boolean; readonly of?: AgentTarget }
  | { readonly _tag: "Logs" };

/** What the agent reads back. */
export interface BrowserReport {
  readonly text: string;
  /** A PNG, base64. */
  readonly image?: string;
}

/** What `inspect` answers, from the page helpers. */
interface Inspection {
  readonly url: string;
  readonly title: string;
  readonly viewport: readonly [number, number];
  readonly scroll: readonly [number, number];
  readonly elements: ReadonlyArray<{
    readonly role: string;
    readonly name: string;
    readonly box: readonly [number, number, number, number];
    readonly states?: ReadonlyArray<string>;
    readonly value?: string;
  }>;
  readonly text?: string;
}

const where = (page: { readonly url: string; readonly title: string }) =>
  page.title === "" ? page.url : `${page.title} — ${page.url}`;

const pageLine = async (page: Page) => {
  const { url, title } = await page.evaluate<{ url: string; title: string }>(
    "({ url: location.href, title: document.title })",
  );
  return `Page: ${where({ url, title })}`;
};

/** A line on the errors and failed requests waiting for `browser_logs`, when there are any. */
const unreadLine = (page: Page): ReadonlyArray<string> => {
  const { errors, requests } = page.unread;
  if (errors === 0 && requests === 0) return [];
  const parts = [
    ...(errors > 0 ? [`${errors} console error${errors === 1 ? "" : "s"}`] : []),
    ...(requests > 0 ? [`${requests} failed request${requests === 1 ? "" : "s"}`] : []),
  ];
  return [`${parts.join(" and ")} since the last browser_logs.`];
};

/** The page as an agent reads it: where it is, its controls and headings with their places, its text. */
export const describePage = (inspection: Inspection): string => {
  const [width, height] = inspection.viewport;
  const [x, y] = inspection.scroll;
  const lines = [
    `Page: ${where(inspection)}`,
    `Viewport ${width}x${height}, scrolled to ${x},${y}. Points are the centre of each element, in viewport pixels.`,
  ];
  if (inspection.elements.length === 0) lines.push("No controls or headings show.");
  for (const element of inspection.elements) {
    const [left, top, w, h] = element.box;
    const name = element.name === "" ? "" : ` "${element.name}"`;
    const value = element.value === undefined ? "" : ` value="${element.value}"`;
    const states = element.states === undefined ? "" : ` (${element.states.join(", ")})`;
    lines.push(
      `- ${element.role}${name}${value}${states} @${Math.round(left + w / 2)},${Math.round(top + h / 2)}`,
    );
  }
  if (inspection.text !== undefined) lines.push("", "Text:", inspection.text.trim() || "(none)");
  return lines.join("\n");
};

const stepOf = (step: AgentStep) =>
  fromJson({
    action: step.action,
    text: step.text,
    selector: step.selector,
    nth: step.nth,
    x: step.x,
    y: step.y,
    to: step.to,
    value: step.value,
    ms: step.ms,
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const base64 = (png: Uint8Array) => Buffer.from(png).toString("base64");

/**
 * Runs `command` on `page`. `navigate` opens a URL the preview's way (the desktop shell loads it in
 * its view, which keeps its own history); failures read as text the agent can act on.
 */
export const runCommand = async (
  page: Page,
  command: BrowserCommand,
  navigate: (url: string) => Promise<void>,
): Promise<BrowserReport> => {
  switch (command._tag) {
    case "Open": {
      if (command.url !== undefined) {
        const url = previewUrl(command.url);
        if (url === undefined)
          throw new CdpError(`The browser opens http and https pages only, not ${command.url}.`);
        await navigate(url);
      } else if (command.go === "back") await page.back();
      else if (command.go === "forward") await page.forward();
      else if (command.go === "reload") await page.reload();
      else await page.settle();
      return { text: [await pageLine(page), ...unreadLine(page)].join("\n") };
    }
    case "Read": {
      const inspection = await page.inspect(command.text);
      return { text: [describePage(inspection as Inspection), ...unreadLine(page)].join("\n") };
    }
    case "Act": {
      const lines: Array<string> = [];
      for (const [index, step] of command.steps.entries()) {
        try {
          const done = await runStep(page, stepOf(step));
          const at = typeof done["at"] === "string" ? ` → ${done["at"]}` : "";
          const more = typeof done["matches"] === "number" ? ` (first of ${done["matches"]} matches)` : "";
          lines.push(`${index + 1}. ${step.action}${at}${more}`);
        } catch (error) {
          lines.push(`${index + 1}. ${step.action} failed: ${message(error)}`);
          if (index < command.steps.length - 1) lines.push("The steps after it didn't run.");
          break;
        }
      }
      await page.settle();
      lines.push(await pageLine(page), ...unreadLine(page));
      if (!command.screenshot) return { text: lines.join("\n") };
      return { text: lines.join("\n"), image: base64(await page.screenshot({ fullPage: false })) };
    }
    case "Screenshot": {
      const of: Target | undefined = command.of;
      const png = await page.screenshot({ fullPage: command.fullPage, of });
      return { text: [await pageLine(page), ...unreadLine(page)].join("\n"), image: base64(png) };
    }
    case "Logs": {
      // A development build of Electron warns every page about its own policy; the page's author can't act on it.
      const console = page
        .drainConsole()
        .filter((entry) => !entry.text.includes("Electron Security Warning"));
      const requests = page.drainRequests();
      const lines = [await pageLine(page)];
      lines.push(
        console.length === 0
          ? "Console: nothing."
          : `Console:\n${console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`,
      );
      lines.push(
        requests.length === 0
          ? "Failed requests: none."
          : `Failed requests:\n${requests.map((each) => `${each.method} ${each.url} → ${each.failure}`).join("\n")}`,
      );
      return { text: lines.join("\n") };
    }
  }
};
