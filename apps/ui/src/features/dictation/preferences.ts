import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";
import { languageOfLocale, speechLanguages, speechModels, type SpeechModelId } from "./model.ts";

// Dictation's choices, kept in this window's local storage like its other preferences.

const LANGUAGE_KEY = "cerium:dictationLanguage";
const MODEL_KEY = "cerium:dictationModel";

/** The language spoken; Whisper can't tell it alone. The system's own until changed. */
export const dictationLanguageAtom = Atom.writable(
  () =>
    speechLanguages.find(([code]) => code === stored(LANGUAGE_KEY))?.[0] ??
    languageOfLocale(navigator.language),
  (context, value: string) => {
    context.setSelf(value);
    remember(LANGUAGE_KEY, value);
  },
).pipe(Atom.keepAlive);

export const dictationModelAtom = Atom.writable(
  (): SpeechModelId => speechModels.find((model) => model.id === stored(MODEL_KEY))?.id ?? "base",
  (context, value: SpeechModelId) => {
    context.setSelf(value);
    remember(MODEL_KEY, value);
  },
).pipe(Atom.keepAlive);

/** The models this window has downloaded once, so it doesn't warn of a download again. */
const DOWNLOADED_KEY = "cerium:dictationDownloaded";
export const downloadedModelsAtom = Atom.writable(
  (): ReadonlyArray<SpeechModelId> =>
    speechModels.flatMap((model) =>
      (stored(DOWNLOADED_KEY) ?? "").split(",").includes(model.id) ? [model.id] : [],
    ),
  (context, value: ReadonlyArray<SpeechModelId>) => {
    context.setSelf(value);
    remember(DOWNLOADED_KEY, value.join(","));
  },
).pipe(Atom.keepAlive);
