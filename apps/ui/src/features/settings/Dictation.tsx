import { useAtom, useAtomValue } from "@effect/atom-react";

import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { DICTATION_SHORTCUT } from "../dictation/DictationControl.tsx";
import { speechLanguages, speechModel, speechModels, type SpeechModelId } from "../dictation/model.ts";
import { dictationLanguageAtom, dictationModelAtom, downloadedModelsAtom } from "../dictation/preferences.ts";
import { Keys, SettingsCard, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";

const languageName = (code: string) => speechLanguages.find(([each]) => each === code)?.[1] ?? code;

/** Dictation's language and speech model; the microphone button sits in every message box. */
export function DictationSettings() {
  const [language, setLanguage] = useAtom(dictationLanguageAtom);
  const [model, setModel] = useAtom(dictationModelAtom);
  const downloaded = useAtomValue(downloadedModelsAtom);
  const sizeOf = (id: SpeechModelId) =>
    downloaded.includes(id) ? "Downloaded" : `About ${speechModel(id).size} MB`;

  return (
    <SettingsPage title="Dictation">
      <SettingsSection
        title="Speech to text"
        info="Speech is turned into text on this computer by OpenAI's Whisper, so what you say never leaves it. The model downloads once from Hugging Face, the first time you dictate."
      >
        <SettingsCard className="divide-y divide-line-subtle">
          <SettingsRow
            label="Language"
            hint="The language you speak"
            control={() => (
              <SelectRoot value={language} onValueChange={(next) => next !== null && setLanguage(next)}>
                <SelectTrigger label="Dictation language">{languageName(language)}</SelectTrigger>
                <SelectPopup>
                  {speechLanguages.map(([code, name]) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </SelectRoot>
            )}
          />
          <SettingsRow
            label="Model"
            hint={sizeOf(model)}
            control={() => (
              <SelectRoot
                value={model}
                onValueChange={(next) => next !== null && setModel(next as SpeechModelId)}
              >
                <SelectTrigger label="Speech model">{speechModel(model).label}</SelectTrigger>
                <SelectPopup>
                  {speechModels.map((each) => (
                    <SelectItem
                      key={each.id}
                      value={each.id}
                      description={`${each.note} · ${sizeOf(each.id)}`}
                    >
                      {each.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </SelectRoot>
            )}
          />
          <SettingsRow
            label="Start or stop dictating"
            hint="Esc drops the recording"
            control={() => <Keys keys={DICTATION_SHORTCUT} size="sm" />}
          />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}
