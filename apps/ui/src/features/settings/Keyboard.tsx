import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useAtom } from "@effect/atom-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { WEB } from "../../backend/target.ts";
import { Keys, SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
import { isSendKey, sendKeyAtom, type SendKey } from "./preferences.ts";
import { canScale } from "./scale.ts";

const sendKeys: ReadonlyArray<{ readonly value: SendKey; readonly send: string; readonly newLine: string }> =
  [
    { value: "enter", send: "Enter", newLine: "Shift Enter" },
    { value: "ctrlEnter", send: "Ctrl Enter", newLine: "Enter" },
  ];

const shortcuts: ReadonlyArray<readonly [action: string, keys: string]> = [
  ["New thread", "Ctrl N"],
  ["Search threads, or run a command", "Ctrl K"],
  ["Open the sidebar's first ten threads", "Ctrl 1–0"],
  ["Switch to Work", "Ctrl Shift 1"],
  ["Switch to Chat", "Ctrl Shift 2"],
  ["Show or hide the sidebar", "Ctrl B"],
  ["Show or hide the thread's agents", "Ctrl J"],
  ["Show, focus or hide the terminal", "Ctrl `"],
  ["Open or close settings", "Ctrl ,"],
  ["Stop the running turn, or leave settings", "Esc"],
  // Only the desktop's message boxes dictate.
  ...(WEB ? [] : ([["Start or stop dictating in the message box", "Ctrl M"]] as const)),
  // The desktop window scales itself; a browser keeps its own zoom keys.
  ...(canScale()
    ? ([
        ["Make everything larger", "Ctrl +"],
        ["Make everything smaller", "Ctrl −"],
        ["Back to 100%", "Ctrl Num0"],
      ] as const)
    : []),
];

const tabShortcuts: ReadonlyArray<readonly [action: string, keys: string]> = [
  ["New thread in a tab", "Ctrl T"],
  ["Close the tab", "Ctrl W"],
  ["Reopen the tab closed last", "Ctrl Shift T"],
  ["Next tab", "Ctrl Tab"],
  ["Previous tab", "Ctrl Shift Tab"],
  ["Go to a tab, 9 being the last", "Alt 1–9"],
  ["Move the tab left or right", "Ctrl Shift PgUp/PgDn"],
  ["Open a sidebar thread in a tab of its own", "Ctrl Click"],
];

const paneShortcuts: ReadonlyArray<readonly [action: string, keys: string]> = [
  ["New thread to the right", "Ctrl \\"],
  ["New thread below", "Ctrl Shift \\"],
];

function ShortcutList({ rows }: { rows: ReadonlyArray<readonly [action: string, keys: string]> }) {
  return (
    <SettingsCard className="divide-y divide-line-subtle">
      {rows.map(([action, keys]) => (
        <div key={action} className="flex h-11 items-center justify-between gap-4 px-4 text-[13px]">
          <span className="text-fg-secondary">{action}</span>
          <Keys keys={keys} size="sm" />
        </div>
      ))}
    </SettingsCard>
  );
}

/** What the try-it box last saw: a send or a new line, lighting up the matching keycaps. */
type Press = "send" | "newLine";

export function KeyboardSettings() {
  const [sendKey, setSendKey] = useAtom(sendKeyAtom);
  const [pressed, setPressed] = useState<Press>();
  const release = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flash = (press: Press) => {
    setPressed(press);
    clearTimeout(release.current);
    release.current = setTimeout(() => setPressed(undefined), 180);
  };

  return (
    <SettingsPage title="Keyboard">
      <SettingsSection title="Sending messages">
        <RadioGroup
          value={sendKey}
          onValueChange={(value) => setSendKey(value as SendKey)}
          aria-label="Send messages with"
          className="grid grid-cols-2 gap-3"
        >
          {sendKeys.map((option) => {
            const active = option.value === sendKey;
            return (
              <Radio.Root
                key={option.value}
                value={option.value}
                nativeButton
                render={<button type="button" aria-label={`${option.send} sends`} />}
                className="group flex flex-col gap-3 rounded-xl border border-line-subtle p-4 text-left transition-[border-color,box-shadow] duration-150 outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:border-accent data-checked:ring-1 data-checked:ring-accent"
              >
                <span className="flex items-center gap-2.5 text-[13px] text-fg-secondary group-data-checked:text-fg-primary">
                  <Keys keys={option.send} pressed={active && pressed === "send"} />
                  <span className="font-medium">sends</span>
                </span>
                <span className="flex items-center gap-2.5 text-xs text-fg-tertiary">
                  <Keys keys={option.newLine} size="sm" pressed={active && pressed === "newLine"} />
                  new line
                </span>
              </Radio.Root>
            );
          })}
        </RadioGroup>
        <TryIt sendKey={sendKey} onPress={flash} />
      </SettingsSection>

      <SettingsSection title="Shortcuts">
        <ShortcutList rows={shortcuts} />
      </SettingsSection>

      <SettingsSection title="Tabs">
        <ShortcutList rows={tabShortcuts} />
      </SettingsSection>

      <SettingsSection title="Split view">
        <ShortcutList rows={paneShortcuts} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** A practice message box: the chosen key sends into a little conversation above it. */
function TryIt({ sendKey, onPress }: { sendKey: SendKey; onPress: (press: Press) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<ReadonlyArray<{ readonly id: number; readonly text: string }>>([]);
  const nextId = useRef(0);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (!isSendKey(event, sendKey)) {
      // Shift Enter, or a plain Enter while Ctrl Enter sends: the box adds the line itself.
      onPress("newLine");
      return;
    }
    event.preventDefault();
    onPress("send");
    if (text.trim() === "") return;
    setSent((current) => [...current.slice(-2), { id: nextId.current++, text: text.trim() }]);
    setText("");
  };

  return (
    <SettingsCard className="overflow-hidden bg-surface-window/40">
      {/* Only once something has been sent does the box grow a conversation above its input. */}
      {sent.length > 0 ? (
        <div className="flex max-h-40 flex-col justify-end gap-2 overflow-hidden mask-t-from-60% px-4 pt-3">
          {sent.map((message) => (
            <div
              key={message.id}
              className="flex justify-end transition-[opacity,translate] duration-300 ease-out-soft starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none"
            >
              {/* Plain text, so the lines the other key added show as lines. */}
              <p className="max-w-[85%] rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-3.5 py-2 text-[13.5px] leading-normal whitespace-pre-wrap text-fg-primary shadow-raised">
                {message.text}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      <div className="p-3">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Try it: type something and press ${sendKey === "enter" ? "Enter" : "Ctrl Enter"}`}
          aria-label="Try sending a message"
          className="block max-h-28 min-h-11 w-full resize-none rounded-xl border border-line-subtle bg-surface-raised px-3.5 py-2.5 text-[13.5px] leading-normal text-fg-primary transition-colors outline-none [field-sizing:content] placeholder:text-fg-tertiary focus:border-line-strong"
        />
      </div>
    </SettingsCard>
  );
}
