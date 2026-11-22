// What the phone's key bar under the terminal sends: the keys a soft keyboard lacks, as the raw
// sequences a shell reads, and the sticky Ctrl that turns the next key into its control character.

export type Arrow = "up" | "down" | "right" | "left";

const ARROW_LETTER = { up: "A", down: "B", right: "C", left: "D" } as const;

/** An arrow's sequence: `ESC O x` once the shell asks for application cursor keys, `ESC [ x` otherwise. */
export const arrowSequence = (direction: Arrow, application: boolean): string =>
  `\x1b${application ? "O" : "["}${ARROW_LETTER[direction]}`;

export const KEY = { escape: "\x1b", tab: "\t", interrupt: "\x03" } as const;

/** Off; latched for the next key alone; locked until tapped again. */
export type Ctrl = "off" | "latched" | "locked";

/** Two taps on Ctrl this close together lock it. */
export const CTRL_LOCK_MS = 300;

/** Ctrl after a tap at `now`, the last one having been at `lastTap`. */
export const tapCtrl = (state: Ctrl, now: number, lastTap: number): Ctrl =>
  state === "off" ? "latched" : state === "latched" && now - lastTap <= CTRL_LOCK_MS ? "locked" : "off";

/** Ctrl after a key went with it: a latch is spent, a lock stays. */
export const afterKey = (state: Ctrl): Ctrl => (state === "latched" ? "off" : state);

const CONTROL_PUNCTUATION: Readonly<Record<string, number>> = {
  " ": 0,
  "@": 0,
  "[": 27,
  "\\": 28,
  "]": 29,
  "^": 30,
  _: 31,
  "/": 31,
  "?": 127,
};

/**
 * `data` as it goes with Ctrl held: a letter or one of the punctuation keys a terminal maps becomes
 * its control character, an arrow takes the Ctrl modifier (`ESC [ 1 ; 5 x`), and anything else (an
 * escape, a paste) goes unchanged.
 */
export const withCtrl = (data: string): string => {
  // oxlint-disable-next-line no-control-regex -- escape sequences are control characters
  const arrow = /^\x1b[[O]([ABCD])$/.exec(data);
  if (arrow !== null) return `\x1b[1;5${arrow[1]}`;
  if (data.length !== 1) return data;
  const code = data.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  const punctuation = CONTROL_PUNCTUATION[data];
  return punctuation === undefined ? data : String.fromCharCode(punctuation);
};

/** Holding an arrow repeats it: first after this long… */
export const REPEAT_DELAY_MS = 400;
/** …then this often. */
export const REPEAT_EVERY_MS = 60;
