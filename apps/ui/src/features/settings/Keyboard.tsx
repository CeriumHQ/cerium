import { useAtom } from "@effect/atom-react";

import { WEB } from "../../backend/target.ts";
import { keyLabel } from "../../lib/keys.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { DICTATION_SHORTCUT } from "../dictation/DictationControl.tsx";
import { Keys, SettingsCard, SettingsList, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";
import { sendKeyAtom, type SendKey } from "./preferences.ts";
import { canScale } from "./scale.ts";

const sendKeys: Record<SendKey, { readonly send: string; readonly newLine: string }> = {
  enter: { send: "Enter", newLine: "Shift Enter" },
  ctrlEnter: { send: "Ctrl Enter", newLine: "Enter" },
};

const shortcuts: ReadonlyArray<readonly [action: string, keys: string]> = [
  ["New thread", "Ctrl N"],
  ["Search threads, or run a command", "Ctrl K"],
  ["Open the sidebar's first ten threads", "Ctrl 1–0"],
  ["Switch to Work", "Ctrl Shift 1"],
  ["Switch to Chat", "Ctrl Shift 2"],
  ["Show or hide the sidebar", "Ctrl B"],
  ["Show or hide the thread's agents", "Ctrl J"],
  ["Show, focus or hide the terminal", "Control `"],
  ["Open or close settings", "Ctrl ,"],
  ["Stop the running turn, or leave settings", "Esc"],
  // Only the desktop's message boxes dictate.
  ...(WEB ? [] : ([["Start or stop dictating in the message box", DICTATION_SHORTCUT]] as const)),
  ["New thread in a tab", "Ctrl T"],
  ["Close the tab", "Ctrl W"],
  ["Reopen the tab closed last", "Ctrl Shift T"],
  ["Next tab", "Control Tab"],
  ["Previous tab", "Control Shift Tab"],
  ["Go to a tab, 9 being the last", "Alt 1–9"],
  ["Move the tab left or right", "Control Shift PgUp/PgDn"],
  ["Open a sidebar thread in a tab of its own", "Ctrl Click"],
  ["New thread to the right", "Ctrl \\"],
  ["New thread below", "Ctrl Shift \\"],
  // The desktop window scales itself; a browser keeps its own zoom keys.
  ...(canScale()
    ? ([
        ["Make everything larger", "Ctrl +"],
        ["Make everything smaller", "Ctrl −"],
        ["Back to 100%", "Ctrl Num0"],
      ] as const)
    : []),
];

export function KeyboardSettings() {
  const [sendKey, setSendKey] = useAtom(sendKeyAtom);
  return (
    <SettingsPage title="Keyboard">
      <SettingsList>
        <SettingsRow
          label="Send messages with"
          hint={`${keyLabel(sendKeys[sendKey].newLine)} starts a new line`}
          className="pr-2.5"
          control={() => (
            <SelectRoot value={sendKey} onValueChange={(next) => next !== null && setSendKey(next)}>
              <SelectTrigger label="Send messages with">
                <span className="font-medium text-fg-primary">{keyLabel(sendKeys[sendKey].send)}</span>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(sendKeys) as ReadonlyArray<SendKey>).map((key) => (
                  <SelectItem
                    key={key}
                    value={key}
                    description={`${keyLabel(sendKeys[key].newLine)} for a new line`}
                  >
                    {keyLabel(sendKeys[key].send)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
      </SettingsList>

      <SettingsSection title="Shortcuts">
        <SettingsCard className="divide-y divide-line-subtle">
          {shortcuts.map(([action, keys]) => (
            <div key={action} className="flex h-10 items-center justify-between gap-4 px-4 text-body">
              <span className="text-fg-secondary">{action}</span>
              <Keys keys={keys} size="sm" />
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}
