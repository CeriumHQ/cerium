// Dictation's plain logic: the speech models and languages offered, how a transcript is cleaned and
// placed beside the text around the caret, where a long recording is cut, and what a failure says.

/** The rate Whisper hears audio at. */
export const SAMPLE_RATE = 16_000;

export type SpeechModelId = "base" | "small";

export interface SpeechModel {
  readonly id: SpeechModelId;
  readonly label: string;
  /** The Hugging Face repository its ONNX weights download from. */
  readonly repo: string;
  /** Roughly how much the first use downloads, in MB. */
  readonly size: number;
  readonly note: string;
}

export const speechModels: ReadonlyArray<SpeechModel> = [
  { id: "base", label: "Base", repo: "onnx-community/whisper-base", size: 210, note: "Quick" },
  { id: "small", label: "Small", repo: "onnx-community/whisper-small", size: 410, note: "More accurate" },
];

export const speechModel = (id: SpeechModelId): SpeechModel =>
  speechModels.find((model) => model.id === id) ?? speechModels[0]!;

/** Languages Whisper transcribes well, by their ISO 639-1 code. */
export const speechLanguages: ReadonlyArray<readonly [code: string, name: string]> = [
  ["en", "English"],
  ["ar", "Arabic"],
  ["zh", "Chinese"],
  ["cs", "Czech"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["de", "German"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["hu", "Hungarian"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["no", "Norwegian"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["es", "Spanish"],
  ["sv", "Swedish"],
  ["th", "Thai"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["vi", "Vietnamese"],
];

/** The language a locale such as `pt-BR` speaks, when Whisper is offered it; else English. */
export const languageOfLocale = (locale: string): string => {
  const code = locale.toLowerCase().split(/[-_]/)[0] ?? "";
  // Norwegian Bokmål and Nynorsk are both Norwegian to Whisper.
  const known = code === "nb" || code === "nn" ? "no" : code;
  return speechLanguages.some(([each]) => each === known) ? known : "en";
};

/**
 * What Whisper heard, as text to type: its sound tags (`[BLANK_AUDIO]`, `(music)`, `*coughs*`) and
 * the spacing around them dropped. Whisper invents a polite sign-off on near silence, so a
 * transcript that is nothing but one counts as nothing heard.
 */
export const cleanTranscript = (text: string): string => {
  const cleaned = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bare = cleaned.toLowerCase().replace(/[.!,]/g, "");
  return silenceWords.has(bare) ? "" : cleaned;
};
const silenceWords = new Set(["you", "thank you", "thanks for watching", "thank you for watching", "bye"]);

/**
 * `spoken` as it goes in at the caret: a space before it after a word, and one after it before a
 * word, so dictating into the middle of a sentence reads as one.
 */
export const spacedInsert = (spoken: string, before: string | undefined, after: string | undefined) => {
  const lead = before !== undefined && before !== "" && !/\s/.test(before) ? " " : "";
  const tail = after !== undefined && after !== "" && !/[\s.,;:!?)]/.test(after) ? " " : "";
  return `${lead}${spoken}${tail}`;
};

/** How long a piece of a recording may grow before it is transcribed while the user keeps talking. */
export const PIECE_SECONDS = 15;
/** How far back from a full piece's end a pause is looked for, to cut it there rather than mid-word. */
const PAUSE_WINDOW_SECONDS = 5;
/** The span whose loudness decides a pause. */
const FRAME_SECONDS = 0.05;

/**
 * Where to cut a recording that has grown to a full piece: at its quietest moment in the last few
 * seconds, so a word isn't split between two transcriptions. Undefined while it is still short.
 */
export const pieceEnd = (samples: Float32Array, rate = SAMPLE_RATE): number | undefined => {
  const full = PIECE_SECONDS * rate;
  if (samples.length < full) return undefined;
  const frame = Math.round(FRAME_SECONDS * rate);
  let quietest = full;
  let lowest = Number.POSITIVE_INFINITY;
  for (let start = full - PAUSE_WINDOW_SECONDS * rate; start + frame <= full; start += frame) {
    let energy = 0;
    for (let index = start; index < start + frame; index++) energy += samples[index]! ** 2;
    if (energy < lowest) {
      lowest = energy;
      quietest = start + Math.round(frame / 2);
    }
  }
  return quietest;
};

/** Whether any of `samples` is louder than near silence: a recording of nothing isn't transcribed. */
export const hasSound = (samples: Float32Array): boolean => {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak > 0.01;
};

/** A recording's length as `m:ss`. */
export const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export type DictationProblem =
  /** Windows' privacy settings keep desktop apps, or Cerium, from the microphone. */
  | "blocked"
  /** No microphone is plugged in or enabled. */
  | "noMicrophone"
  /** Another app holds the microphone, or its driver failed. */
  | "busy"
  /** The speech model couldn't be downloaded. */
  | "download"
  /** The recording ended without any speech in it. */
  | "silent"
  | "failed";

/** The problem a failed `getUserMedia` names. */
export const microphoneProblem = (error: unknown): DictationProblem => {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "noMicrophone";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "failed";
};

export const problemText: Record<DictationProblem, string> = {
  blocked: "Microphone access is turned off",
  noMicrophone: "No microphone found",
  busy: "The microphone is in use by another app",
  download: "Couldn't download the speech model",
  silent: "Didn't hear anything",
  failed: "Dictation stopped working",
};
