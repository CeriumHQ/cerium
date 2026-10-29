import type { NotificationKind } from "@cerium/protocol";

// The sounds Cerium plays itself when a thread finishes, needs the user or fails. Synthesized with
// Web Audio, so there is nothing to ship: a soft two-note rise for finished, two even taps for a
// request, a low two-note fall for a failure. They play while the window has the focus too, which the
// system's own notification sound never does.

export type Cue = "finished" | "needsYou" | "failed";

/** The cues in the order settings lists them. */
export const CUES: ReadonlyArray<Cue> = ["finished", "needsYou", "failed"];

interface Note {
  /** Hz. */
  readonly pitch: number;
  /** Seconds after the cue starts. */
  readonly at: number;
  /** Seconds until the note has faded out. */
  readonly length: number;
  readonly type: OscillatorType;
  /** Relative loudness of the note and of its octave above, which gives it a soft bell. */
  readonly level: number;
  readonly bell: number;
}

const note = (
  pitch: number,
  at: number,
  length: number,
  type: OscillatorType = "sine",
  level = 1,
  bell = 0.2,
): Note => ({ pitch, at, length, type, level, bell });

const NOTES: Record<Cue, ReadonlyArray<Note>> = {
  // E5 up to A5: settled, a little bright.
  finished: [note(659.25, 0, 0.32), note(880, 0.11, 0.5)],
  // The same G5 twice, tighter and plainer than the rise: a tap on the shoulder.
  needsYou: [note(783.99, 0, 0.2, "triangle", 0.9, 0), note(783.99, 0.15, 0.26, "triangle", 0.9, 0)],
  // D4 falling to A3: low and rounder, nothing sharp.
  failed: [note(293.66, 0, 0.3, "triangle", 1, 0.1), note(220, 0.14, 0.55, "triangle", 1, 0.1)],
};

/** The cue for a notification, or none for the kinds that have no sound. */
export const cueFor = (kind: NotificationKind): Cue | undefined => (kind === "limit" ? undefined : kind);

/** How much a cue matters when several arrive together: a failure over a request over a finish. */
const RANK: Record<Cue, number> = { finished: 0, needsYou: 1, failed: 2 };

/** The cue worth playing for a batch of notifications that arrived together, if any. */
export const cueOfBatch = (kinds: ReadonlyArray<NotificationKind>): Cue | undefined => {
  let best: Cue | undefined;
  for (const kind of kinds) {
    const cue = cueFor(kind);
    if (cue !== undefined && (best === undefined || RANK[cue] > RANK[best])) best = cue;
  }
  return best;
};

/** After a cue plays, others stay quiet for this long, so many threads finishing at once make one sound. */
export const QUIET_MS = 2500;

/** What the last sound was and when, as the limiter remembers it. */
export interface Played {
  readonly cue: Cue;
  readonly at: number;
}

/** Whether `cue` plays at `now`: unless one just did, and a more important one is not what comes. */
export const mayPlay = (cue: Cue, last: Played | undefined, now: number): boolean =>
  last === undefined || now - last.at >= QUIET_MS || RANK[cue] > RANK[last.cue];

const LOUDNESS = 0.16;

let context: AudioContext | undefined;
let last: Played | undefined;

const audio = (): AudioContext | undefined => {
  if (typeof AudioContext === "undefined") return undefined;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
};

const schedule = (ctx: AudioContext, cue: Cue) => {
  const start = ctx.currentTime + 0.02;
  for (const each of NOTES[cue]) {
    const at = start + each.at;
    const voice = (pitch: number, level: number) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = each.type;
      oscillator.frequency.value = pitch;
      // A short attack so it doesn't click, then an exponential fade.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(LOUDNESS * level, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + each.length);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + each.length + 0.02);
      oscillator.onended = () => gain.disconnect();
    };
    voice(each.pitch, each.level);
    if (each.bell > 0) voice(each.pitch * 2, each.level * each.bell);
  }
};

/** Plays `cue` now, for a preview in settings: always, and it counts toward the quiet after it. */
export const previewCue = (cue: Cue) => {
  const ctx = audio();
  if (ctx === undefined) return;
  last = { cue, at: Date.now() };
  schedule(ctx, cue);
};

/** Plays `cue` for a thread's news, unless a sound just played that matters as much. */
export const playCue = (cue: Cue) => {
  const now = Date.now();
  if (!mayPlay(cue, last, now)) return;
  previewCue(cue);
};
