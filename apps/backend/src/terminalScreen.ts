import type { SerializeAddon } from "@xterm/addon-serialize";
import type { ITerminalAddon, Terminal } from "@xterm/headless";

// A terminal's screen as the backend keeps it: a headless xterm that reads everything the shell
// prints, so that a viewer arriving later (a reload, another device) is handed the screen as it is
// now, scrollback, colours, alternate screen and modes included, instead of a stretch of raw output
// cut off wherever it began.

/** How many lines scrolled off the top a screen remembers. */
export const SCROLLBACK_LINES = 3_000;

export interface Screen {
  /** Feeds output to the screen; `done` runs once it has been read. */
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  /**
   * The screen after everything written before this call, as output that draws it again; the same
   * one until the screen is written to, resized or reset.
   */
  snapshot(): Promise<string>;
  /**
   * The last `lines` lines of everything written before this call, as plain text: colours and cursor
   * movement are applied, so a progress bar reads as its final state, and a line the terminal wrapped
   * is one line again. Blank lines at the bottom are left off.
   */
  text(lines: number): Promise<string>;
  /** Clears the screen and its scrollback, as for a shell that starts over. */
  reset(): void;
  dispose(): void;
}

export interface ScreenOptions {
  readonly cols: number;
  readonly rows: number;
  /** The Windows build whose ConPTY the shell runs on, which wraps lines itself. */
  readonly windowsBuild?: number | undefined;
}

// Both packages are CommonJS bundles: Node finds one's classes under `default` and the other's by name.
type Loaded<T> = T & { readonly default?: T };
const exported = <T>(module: Loaded<T>): T => module.default ?? module;

/** The last `lines` logical lines of the active buffer, the terminal's wrapped rows joined again. */
const plainTail = (terminal: Terminal, lines: number): string => {
  const buffer = terminal.buffer.active;
  const kept: Array<string> = [];
  let row = buffer.length - 1;
  while (row >= 0 && kept.length < lines) {
    // A wrapped line starts on an earlier row: gather its rows, then read them as one.
    let start = row;
    while (start > 0 && buffer.getLine(start)?.isWrapped === true) start--;
    let line = "";
    for (let each = start; each <= row; each++) line += buffer.getLine(each)?.translateToString(true) ?? "";
    // Rows under the last thing printed are the screen's empty ones, not output.
    if (kept.length > 0 || line !== "") kept.push(line);
    row = start - 1;
  }
  return kept.reverse().join("\n");
};

/** Opens a screen. The emulator is loaded on first use, so a backend that never opens a terminal doesn't. */
export const openScreen = async (options: ScreenOptions): Promise<Screen> => {
  const headless = exported(
    (await import("@xterm/headless")) as unknown as Loaded<{ Terminal: typeof Terminal }>,
  );
  const serialize = exported(
    (await import("@xterm/addon-serialize")) as unknown as Loaded<{ SerializeAddon: typeof SerializeAddon }>,
  );
  const terminal = new headless.Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    ...(options.windowsBuild === undefined
      ? {}
      : { windowsPty: { backend: "conpty" as const, buildNumber: options.windowsBuild } }),
  });
  const serializer = new serialize.SerializeAddon();
  terminal.loadAddon(serializer as unknown as ITerminalAddon);
  // Serializing a long scrollback holds the backend up for a while, so viewers that ask before the
  // screen changes again share the last one.
  let last: Promise<string> | undefined;
  return {
    write: (data, done) => {
      last = undefined;
      terminal.write(data, done);
    },
    resize: (cols, rows) => {
      last = undefined;
      terminal.resize(cols, rows);
    },
    // The callback runs once the terminal has read every write before this one, and nothing after
    // it has been read yet, so the serialized screen is exactly that point in the output.
    snapshot: () =>
      (last ??= new Promise((resolve) => {
        terminal.write("", () => resolve(serializer.serialize()));
      })),
    text: (lines) =>
      new Promise((resolve) => {
        terminal.write("", () => resolve(plainTail(terminal, lines)));
      }),
    reset: () => {
      last = undefined;
      terminal.reset();
    },
    dispose: () => terminal.dispose(),
  };
};
