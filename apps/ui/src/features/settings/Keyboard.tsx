import { useAtom } from "@effect/atom-react";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { keyLabel, usesCommandKey } from "../../lib/keys.ts";
import {
  bindingFor,
  conflictsFor,
  defaultBindings,
  defaultKeysOf,
  eventToBinding,
  setCapturingBinding,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutBindingsAtom,
  shortcutDef,
  type ShortcutId,
} from "../../lib/shortcuts.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { Keys, SettingsCard, SettingsList, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";
import { WEB } from "../../backend/target.ts";
import { sendKeyAtom, type SendKey } from "./preferences.ts";
import { canScale } from "./scale.ts";

const sendKeys: Record<SendKey, { readonly send: string; readonly newLine: string }> = {
  enter: { send: "Enter", newLine: "Shift Enter" },
  ctrlEnter: { send: "Ctrl Enter", newLine: "Enter" },
};

/** Dictation and zoom live in the desktop app, as before: elsewhere their rows stay out of the way. */
const isOffered = (id: string): boolean =>
  id === "dictate" ? !WEB : id.startsWith("zoom-") ? canScale() : true;

/** A pending rebind whose keys another shortcut already has. */
interface Conflict {
  readonly id: ShortcutId;
  readonly keys: string;
  readonly others: ReadonlyArray<ShortcutId>;
}

export function KeyboardSettings() {
  const [sendKey, setSendKey] = useAtom(sendKeyAtom);
  const [bindings, setBindings] = useAtom(shortcutBindingsAtom);
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<ShortcutId | undefined>(undefined);
  const [conflict, setConflict] = useState<Conflict | undefined>(undefined);
  const rebound = SHORTCUTS.filter((each) => bindings[each.id] !== defaultKeysOf(each)).length;

  // While a row listens for its new keys, the window's own shortcuts stay out of the way.
  useEffect(() => {
    if (capturing === undefined) return;
    setCapturingBinding(true);
    const listener = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(undefined);
        return;
      }
      const next = eventToBinding(event, usesCommandKey());
      if (next === undefined) return;
      const id = capturing;
      if (next === bindings[id]) {
        setCapturing(undefined);
        return;
      }
      const others = conflictsFor({ ...bindings, [id]: next }, id, usesCommandKey());
      setCapturing(undefined);
      if (others.length > 0) setConflict({ id, keys: next, others });
      else {
        setConflict(undefined);
        setBindings({ ...bindings, [id]: next });
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
      setCapturingBinding(false);
    };
  }, [capturing, bindings, setBindings]);

  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const matches = (id: ShortcutId): boolean => {
    if (words.length === 0) return true;
    const each = shortcutDef(id);
    if (each === undefined) return false;
    const haystack =
      `${each.label} ${each.group} ${each.keywords ?? ""} ${bindingFor(bindings, each.id)} ${keyLabel(each.displayKeys ?? defaultKeysOf(each))}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };

  const swap = () => {
    if (conflict === undefined) return;
    const current = bindings[conflict.id] ?? "";
    const next = { ...bindings, [conflict.id]: conflict.keys };
    for (const other of conflict.others) next[other] = current;
    setBindings(next);
    setConflict(undefined);
  };

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
                <span>{keyLabel(sendKeys[sendKey].send)}</span>
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

      <SettingsSection
        title="Shortcuts"
        description="Select a shortcut, then press the new keys. Esc keeps what it had."
        action={
          rebound > 0 ? (
            <button
              type="button"
              onClick={() => {
                setBindings(defaultBindings());
                setConflict(undefined);
              }}
              className="shrink-0 rounded-md px-2 py-1 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
            >
              Reset all
            </button>
          ) : undefined
        }
      >
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line-subtle bg-surface-sunken px-2.5 text-body text-fg-secondary focus-within:border-line-strong">
          <Search size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            className="min-w-0 flex-1 bg-transparent text-fg-primary outline-none placeholder:text-fg-tertiary"
          />
        </label>
        {SHORTCUT_GROUPS.map((group) => {
          const rows = SHORTCUTS.filter(
            (each) => each.group === group && isOffered(each.id) && matches(each.id),
          );
          if (rows.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-2">
              <h3 className="px-1 text-meta font-medium text-fg-secondary">{group}</h3>
              <SettingsCard className="divide-y divide-line-subtle">
                {rows.map((each) => {
                  const keys = bindingFor(bindings, each.id);
                  const defaults = defaultKeysOf(each);
                  const changed = keys !== defaults;
                  const waiting = capturing === each.id;
                  // The row being rebound asks what to do; the rows already on those keys are marked.
                  const disputed = conflict?.id === each.id;
                  const taken = conflict?.others.includes(each.id) === true;
                  return (
                    <div key={each.id}>
                      {/* The whole row labels its keys' button, so a click anywhere on it starts listening. */}
                      <label
                        {...(each.fixed ? {} : { htmlFor: `shortcut-${each.id}` })}
                        className={`flex min-h-10 items-center justify-between gap-4 px-4 py-1.5 text-body transition-colors ${
                          each.fixed ? "" : waiting ? "bg-surface-hover" : "hover:bg-surface-hover"
                        }`}
                      >
                        <span
                          className={`min-w-0 flex-1 truncate ${waiting ? "text-fg-primary" : "text-fg-secondary"}`}
                        >
                          {each.label}
                        </span>
                        {each.fixed ? (
                          <span className="flex shrink-0 items-center gap-2">
                            <Keys keys={each.displayKeys ?? defaults} size="sm" />
                            <span className="w-12 text-right text-meta text-fg-tertiary">Built-in</span>
                          </span>
                        ) : (
                          <span className="flex shrink-0 items-center gap-1">
                            {changed && !waiting ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setBindings({ ...bindings, [each.id]: defaults });
                                  setConflict(undefined);
                                }}
                                aria-label={`Reset ${each.label}`}
                                title={`Back to ${keyLabel(defaults)}`}
                                className="rounded-md px-1.5 py-1 text-meta text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                              >
                                Reset
                              </button>
                            ) : null}
                            <button
                              type="button"
                              id={`shortcut-${each.id}`}
                              onClick={() => {
                                setConflict(undefined);
                                setCapturing(waiting ? undefined : each.id);
                              }}
                              aria-label={`${each.label}: ${keyLabel(keys)}. ${waiting ? "Press the new keys, or Esc to keep these." : "Select to rebind."}`}
                              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                            >
                              {waiting ? (
                                // In the keys' place while it listens, so the row keeps its height.
                                <span className="flex h-5.5 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary ring-1 ring-focus-ring">
                                  Press keys
                                  <span className="text-fg-tertiary">· Esc keeps {keyLabel(keys)}</span>
                                </span>
                              ) : (
                                <span
                                  className={`flex rounded-md ${taken ? "ring-1 ring-attention ring-offset-2 ring-offset-surface-raised" : ""}`}
                                >
                                  <Keys keys={keys} size="sm" />
                                </span>
                              )}
                            </button>
                          </span>
                        )}
                      </label>
                      {disputed && conflict !== undefined ? (
                        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
                          <span className="min-w-0 flex-1 text-meta leading-relaxed text-fg-secondary">
                            {keyLabel(conflict.keys)} already {conflict.others.length > 1 ? "run" : "runs"}{" "}
                            {conflict.others.map((other) => shortcutDef(other)?.label ?? other).join(", ")}.
                          </span>
                          <button
                            type="button"
                            onClick={swap}
                            className="shrink-0 rounded-md bg-accent px-2 py-1 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90"
                          >
                            Swap
                          </button>
                          <button
                            type="button"
                            onClick={() => setConflict(undefined)}
                            className="shrink-0 rounded-md px-2 py-1 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </SettingsCard>
            </div>
          );
        })}
        {SHORTCUTS.some((each) => matches(each.id)) ? null : (
          <p className="px-1 py-4 text-center text-body text-fg-tertiary">Nothing matches.</p>
        )}
        <p className="px-1 text-meta leading-relaxed text-fg-tertiary">
          Shortcuts marked Built-in stay as they are: a click has no keys to press, and leaving is always Esc.
        </p>
      </SettingsSection>
    </SettingsPage>
  );
}
