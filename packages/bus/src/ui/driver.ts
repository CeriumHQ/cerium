import type { AgentId } from "@cerium/protocol";
import { Context, Data, Effect, Layer, Schedule } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  debuggerOrigin,
  findBrowser,
  launchBrowser,
  pickPage,
  type BrowserKind,
  type LaunchedBrowser,
} from "./browser.ts";
import { Page } from "./page.ts";

// Each agent drives at most one page, in a browser Cerium started for it or in an app it attached to.
// Calls for one agent run one at a time; a page nobody touched for a while is closed.

export class UiError extends Data.TaggedError("UiError")<{ readonly message: string }> {}

export interface OpenOptions {
  readonly url?: string | undefined;
  /** A debugging port or URL of an app already running (an Electron shell, a browser). */
  readonly attach?: string | undefined;
  /** With `attach`, the page whose URL contains this. */
  readonly match?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly scale?: number | undefined;
  readonly mobile?: boolean | undefined;
  readonly colorScheme?: "light" | "dark" | undefined;
  readonly visible?: boolean | undefined;
  readonly browser?: BrowserKind | undefined;
}

interface Session {
  page: Page;
  readonly browser: LaunchedBrowser | undefined;
  readonly visible: boolean;
  readonly directory: string;
  shots: number;
  lastUsed: number;
  /** The call running now; the next waits for it. */
  queue: Promise<unknown>;
}

/** How long a page may sit unused before it closes. */
const IDLE_MS = 20 * 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class UiDriver extends Context.Service<
  UiDriver,
  {
    open(
      agentId: AgentId,
      options: OpenOptions,
    ): Effect.Effect<{ readonly url: string; readonly title: string }, UiError>;
    /** Runs `action` on the agent's page, after any call of theirs still running. */
    use<A>(agentId: AgentId, action: (page: Page) => Promise<A>): Effect.Effect<A, UiError>;
    /** Writes a screenshot where the agent can read it again, and returns the path. */
    save(agentId: AgentId, png: Uint8Array): Effect.Effect<string>;
    close(agentId: AgentId): Effect.Effect<boolean>;
  }
>()("cerium/bus/UiDriver") {
  static readonly layer = Layer.effect(
    UiDriver,
    Effect.gen(function* () {
      const sessions = new Map<AgentId, Session>();

      const shut = (agentId: AgentId) => {
        const session = sessions.get(agentId);
        if (session === undefined) return false;
        sessions.delete(agentId);
        session.page.close();
        session.browser?.close();
        return true;
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const agentId of [...sessions.keys()]) shut(agentId);
        }),
      );
      yield* Effect.sync(() => {
        const now = Date.now();
        for (const [agentId, session] of sessions) {
          if (now - session.lastUsed > IDLE_MS || session.page.closed) shut(agentId);
        }
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

      const serially = <A>(session: Session, action: () => Promise<A>): Promise<A> => {
        const run = session.queue.then(action, action);
        session.queue = run.catch(() => undefined);
        session.lastUsed = Date.now();
        return run;
      };

      const start = async (agentId: AgentId, options: OpenOptions, existing: Session | undefined) => {
        const width = options.width ?? 1280;
        const height = options.height ?? 800;
        const emulate =
          options.width !== undefined || options.height !== undefined || options.mobile !== undefined;
        let session = existing;
        // A different kind of page than the one open starts over.
        const reusable =
          session !== undefined &&
          !session.page.closed &&
          options.attach === undefined &&
          session.browser !== undefined &&
          (options.visible ?? false) === session.visible;
        if (!reusable) {
          shut(agentId);
          let browser: LaunchedBrowser | undefined;
          let origin: string;
          if (options.attach !== undefined) {
            origin = debuggerOrigin(options.attach);
          } else {
            const executable = findBrowser(options.browser);
            if (executable === undefined) {
              throw new Error(
                "No Edge or Chrome is installed to drive. Install one, or attach to an app started with --remote-debugging-port.",
              );
            }
            browser = await launchBrowser({ executable, visible: options.visible ?? false, width, height });
            origin = browser.origin;
          }
          try {
            const target = await pickPage(origin, options.match);
            const page = await Page.open(target.webSocketDebuggerUrl);
            const directory = join(tmpdir(), "cerium-ui", agentId);
            mkdirSync(directory, { recursive: true });
            session = {
              page,
              browser,
              visible: options.visible ?? false,
              directory,
              shots: existing?.shots ?? 0,
              lastUsed: Date.now(),
              queue: Promise.resolve(),
            };
            sessions.set(agentId, session);
          } catch (error) {
            browser?.close();
            throw error;
          }
        }
        const page = session!.page;
        if (session!.browser !== undefined || emulate) {
          await page.viewport({ width, height, scale: options.scale ?? 1, mobile: options.mobile ?? false });
        }
        if (options.colorScheme !== undefined) await page.colorScheme(options.colorScheme);
        if (options.url !== undefined) await page.navigate(options.url);
        else await page.settle();
        return page.evaluate<{ url: string; title: string }>(
          "({ url: location.href, title: document.title })",
        );
      };

      return UiDriver.of({
        open: (agentId, options) =>
          Effect.tryPromise({
            try: () => {
              const existing = sessions.get(agentId);
              return existing === undefined
                ? start(agentId, options, undefined)
                : serially(existing, () => start(agentId, options, existing));
            },
            catch: (error) => new UiError({ message: message(error) }),
          }),

        use: (agentId, action) =>
          Effect.suspend(() => {
            const session = sessions.get(agentId);
            if (session === undefined || session.page.closed) {
              if (session !== undefined) shut(agentId);
              return Effect.fail(new UiError({ message: "No page is open. Call ui_open first." }));
            }
            return Effect.tryPromise({
              try: () => serially(session, () => action(session.page)),
              catch: (error) => new UiError({ message: message(error) }),
            });
          }),

        save: (agentId, png) =>
          Effect.sync(() => {
            const session = sessions.get(agentId);
            const directory = session?.directory ?? join(tmpdir(), "cerium-ui", agentId);
            mkdirSync(directory, { recursive: true });
            const count = session === undefined ? Date.now() : ++session.shots;
            const path = join(directory, `shot-${String(count).padStart(3, "0")}.png`);
            writeFileSync(path, png);
            return path;
          }),

        close: (agentId) => Effect.sync(() => shut(agentId)),
      });
    }),
  );
}
