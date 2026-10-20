import type { DictationProblem, SpeechModelId } from "./model.ts";

// The window's side of the speech worker (speech.worker.ts): one worker for every composer, started
// the first time someone dictates, which keeps its model loaded for the next time.

export type SpeechRequest =
  /** Loads the model now, so its download runs while the user is still talking. */
  | { readonly kind: "prepare"; readonly model: SpeechModelId }
  | {
      readonly kind: "transcribe";
      readonly id: number;
      readonly model: SpeechModelId;
      readonly language: string;
      /** Mono samples at 16 kHz. */
      readonly audio: Float32Array;
    };

export type SpeechResponse =
  /** How much of the model has downloaded, 0 to 1; only on its first use. */
  | { readonly kind: "progress"; readonly model: SpeechModelId; readonly share: number }
  | { readonly kind: "ready"; readonly model: SpeechModelId; readonly device: "webgpu" | "wasm" }
  | { readonly kind: "done"; readonly id: number; readonly text: string }
  | {
      readonly kind: "failed";
      /** Absent when loading failed for a `prepare`. */
      readonly id?: number;
      readonly problem: Extract<DictationProblem, "download" | "failed">;
      readonly message: string;
    };

export class SpeechError extends Error {
  readonly problem: Extract<DictationProblem, "download" | "failed">;
  constructor(problem: Extract<DictationProblem, "download" | "failed">, message: string) {
    super(message);
    this.problem = problem;
  }
}

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (text: string) => void; reject: (error: SpeechError) => void }>();
const listeners = new Set<(response: SpeechResponse) => void>();

const getWorker = () => {
  if (worker === undefined) {
    worker = new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<SpeechResponse>) => {
      const response = event.data;
      if (response.kind === "done" || (response.kind === "failed" && response.id !== undefined)) {
        const pending = waiting.get(response.id!);
        waiting.delete(response.id!);
        if (response.kind === "done") pending?.resolve(response.text);
        else pending?.reject(new SpeechError(response.problem, response.message));
      }
      for (const listener of listeners) listener(response);
    });
  }
  return worker;
};

/** Hears the worker's progress and failures; returns how to stop. */
export const onSpeech = (listener: (response: SpeechResponse) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const prepareSpeech = (model: SpeechModelId) =>
  getWorker().postMessage({ kind: "prepare", model } satisfies SpeechRequest);

/** What `audio` says, as Whisper wrote it. */
export const transcribe = (audio: Float32Array, model: SpeechModelId, language: string): Promise<string> => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    // The samples move to the worker rather than being copied.
    getWorker().postMessage({ kind: "transcribe", id, model, language, audio } satisfies SpeechRequest, [
      audio.buffer,
    ]);
  });
};
