import { useAtom, useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { microphoneProblem, cleanTranscript, hasSound, pieceEnd, type DictationProblem } from "./model.ts";
import { openMicrophone, type Microphone } from "./microphone.ts";
import { dictationLanguageAtom, dictationModelAtom, downloadedModelsAtom } from "./preferences.ts";
import { onSpeech, prepareSpeech, SpeechError, transcribe } from "./speech.ts";

export type DictationState =
  | { readonly phase: "idle" }
  /** Waiting for the microphone, which may take a moment the first time. */
  | { readonly phase: "starting" }
  | { readonly phase: "recording"; readonly since: number }
  /** The microphone is off; what was said last is still being written. */
  | { readonly phase: "finishing" }
  | { readonly phase: "failed"; readonly problem: DictationProblem };

export interface Dictation {
  readonly state: DictationState;
  /** How much of the speech model has downloaded, while it does on first use. */
  readonly download: number | undefined;
  /** How loud the user is, 0 to 1, read each frame by the meter. */
  readonly level: () => number;
  /** Starts listening, or stops and writes out the rest. */
  readonly toggle: () => void;
  /** Stops listening and drops what wasn't written yet. */
  readonly cancel: () => void;
  readonly dismiss: () => void;
}

/** How often the recording is checked for a piece long enough to transcribe while talking goes on. */
const CHECK_MS = 500;
/** How long "didn't hear anything" stays; it needs nothing done. */
const SILENT_NOTICE_MS = 4_000;

/**
 * `problem`, unless the system's privacy settings block the microphone, which Chromium reports as a
 * device that wouldn't start, or as silence.
 */
const blockedOr = async (problem: DictationProblem): Promise<DictationProblem> => {
  const access = await shellBridge()
    ?.microphoneAccess?.()
    .catch(() => undefined);
  return access === "denied" ? "blocked" : problem;
};

/**
 * Dictation into a message box: the microphone's audio is transcribed in pieces cut at pauses, so a
 * long prompt appears as the user talks, and each piece's text goes to `onText` in order.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>({ phase: "idle" });
  const [download, setDownload] = useState<number>();
  const model = useAtomValue(dictationModelAtom);
  const language = useAtomValue(dictationLanguageAtom);
  const [downloaded, setDownloaded] = useAtom(downloadedModelsAtom);
  const microphone = useRef<Microphone>(undefined);
  /** Each session's own: a cancelled session's pieces still in the worker are dropped. */
  const session = useRef(0);
  /** Heard but not yet sent for transcription. */
  const heard = useRef(new Float32Array(0));
  /** The pieces in order: each writes its text only after the ones before it. */
  const written = useRef<Promise<void>>(Promise.resolve());
  /** Whether this session wrote anything, so an empty one can say it heard nothing. */
  const wrote = useRef(false);

  const write = useEffectEvent((text: string) => onText(text));
  const fail = (problem: DictationProblem) => {
    session.current++;
    microphone.current?.stop();
    microphone.current = undefined;
    setState({ phase: "failed", problem });
  };

  const send = (samples: Float32Array) => {
    const own = session.current;
    const text = hasSound(samples) ? transcribe(samples, model, language) : Promise.resolve("");
    written.current = written.current.then(() =>
      text.then(
        (said) => {
          const cleaned = cleanTranscript(said);
          if (own !== session.current || cleaned === "") return;
          wrote.current = true;
          write(cleaned);
        },
        (error: unknown) => {
          if (own === session.current) fail(error instanceof SpeechError ? error.problem : "failed");
        },
      ),
    );
  };

  const join = (more: Float32Array) => {
    const joined = new Float32Array(heard.current.length + more.length);
    joined.set(heard.current);
    joined.set(more, heard.current.length);
    heard.current = joined;
  };

  const start = async () => {
    const own = ++session.current;
    setState({ phase: "starting" });
    heard.current = new Float32Array(0);
    wrote.current = false;
    // The model loads while the user talks; the first time, that's its download.
    prepareSpeech(model);
    try {
      const opened = await openMicrophone();
      if (own !== session.current) {
        opened.stop();
        return;
      }
      microphone.current = opened;
      setState({ phase: "recording", since: Date.now() });
    } catch (error) {
      const problem = await blockedOr(microphoneProblem(error));
      if (own === session.current) fail(problem);
    }
  };

  const stop = () => {
    const opened = microphone.current;
    if (opened === undefined) return;
    microphone.current = undefined;
    join(opened.stop());
    const rest = heard.current;
    heard.current = new Float32Array(0);
    setState({ phase: "finishing" });
    send(rest);
    const own = session.current;
    void written.current.then(async () => {
      if (own !== session.current) return;
      if (wrote.current) return setState({ phase: "idle" });
      // Windows may hand over a blocked microphone as silence.
      const problem = await blockedOr("silent");
      if (own === session.current) setState({ phase: "failed", problem });
    });
  };

  const cancel = () => {
    session.current++;
    microphone.current?.stop();
    microphone.current = undefined;
    heard.current = new Float32Array(0);
    setState({ phase: "idle" });
  };

  // While recording, a piece that grew long enough is cut at a pause and transcribed.
  const check = useEffectEvent(() => {
    const opened = microphone.current;
    if (opened === undefined) return;
    join(opened.take());
    const end = pieceEnd(heard.current);
    if (end === undefined) return;
    send(heard.current.slice(0, end));
    heard.current = heard.current.slice(end);
  });
  const recording = state.phase === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(check, CHECK_MS);
    return () => clearInterval(timer);
  }, [recording]);

  const progress = useEffectEvent((share: number | undefined, ready: boolean) => {
    setDownload(share);
    if (ready && !downloaded.includes(model)) setDownloaded([...downloaded, model]);
  });
  useEffect(
    () =>
      onSpeech((response) => {
        if (response.kind === "progress" && response.model === model) progress(response.share, false);
        else if (response.kind === "ready" && response.model === model) progress(undefined, true);
        else if (response.kind === "failed" && response.id === undefined) {
          progress(undefined, false);
          if (microphone.current !== undefined) fail(response.problem);
        }
      }),
    [model],
  );

  const silent = state.phase === "failed" && state.problem === "silent";
  useEffect(() => {
    if (!silent) return;
    const timer = setTimeout(
      () => setState((current) => (current.phase === "failed" ? { phase: "idle" } : current)),
      SILENT_NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [silent]);

  // Leaving the box lets go of the microphone.
  useEffect(
    () => () => {
      session.current++;
      microphone.current?.stop();
    },
    [],
  );

  return {
    state,
    // A model already downloaded loads from the cache, which isn't worth a progress bar.
    download: downloaded.includes(model) ? undefined : download,
    level: () => microphone.current?.level() ?? 0,
    toggle: () => {
      if (state.phase === "recording") stop();
      else if (state.phase === "idle" || state.phase === "failed") void start();
    },
    cancel,
    dismiss: () => setState((current) => (current.phase === "failed" ? { phase: "idle" } : current)),
  };
}
