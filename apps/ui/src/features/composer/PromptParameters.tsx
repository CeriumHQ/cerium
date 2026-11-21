import type { PromptParameter } from "@cerium/protocol";
import { Braces } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { buttonClass } from "../../components/ui/Button.tsx";
import { keyLabel } from "../../lib/keys.ts";

/**
 * The values a saved prompt asks for, filled in above the message box before its text goes in: one
 * field per parameter, its default already there. Enter inserts, Esc goes back to the slash menu.
 */
export function PromptParameters({
  prompt,
  parameters,
  onInsert,
  onCancel,
}: {
  readonly prompt: string;
  readonly parameters: ReadonlyArray<PromptParameter>;
  readonly onInsert: (values: ReadonlyMap<string, string>) => void;
  readonly onCancel: () => void;
}) {
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onInsert(
          new Map(
            parameters.map(({ name }) => {
              const value = values.get(name);
              return [name, typeof value === "string" ? value : ""];
            }),
          ),
        );
      }}
      className="mx-2.5 mt-2.5 rounded-xl border border-line-subtle bg-surface-hover/60 p-2.5 starting:opacity-0 transition-opacity duration-200 ease-out-soft max-md:p-3"
    >
      <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 flex w-full min-w-0 items-center gap-1.5 p-0 text-caption text-fg-tertiary max-md:text-[13px]">
          <Braces size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate font-medium text-fg-secondary">{prompt}</span>
          <span className="shrink-0 max-[22.5rem]:hidden">· fill in before inserting</span>
        </legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-2 gap-y-2">
          {parameters.map(({ name, defaultValue }, index) => (
            <label key={name} className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-mono text-caption text-fg-tertiary max-md:text-[13px]">
                {name}
              </span>
              <input
                ref={index === 0 ? first : undefined}
                name={name}
                defaultValue={defaultValue}
                onKeyDown={escape}
                spellCheck={false}
                autoComplete="off"
                placeholder={defaultValue ? undefined : name}
                className="h-7 w-full min-w-0 rounded-md border border-line-strong bg-surface-sunken px-2 text-body text-fg-primary outline-none transition-colors placeholder:text-fg-disabled focus-visible:border-fg-tertiary max-md:h-10 max-md:text-[15px]"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <span className="mr-auto text-caption text-fg-tertiary max-md:hidden">
            <kbd className="font-sans">{keyLabel("Enter")}</kbd> to insert ·{" "}
            <kbd className="font-sans">{keyLabel("Esc")}</kbd> to cancel
          </span>
          <button
            type="button"
            onClick={onCancel}
            onKeyDown={escape}
            className={buttonClass({ tone: "quiet", size: "sm" })}
          >
            Cancel
          </button>
          <button type="submit" onKeyDown={escape} className={buttonClass({ tone: "primary", size: "sm" })}>
            Insert prompt
          </button>
        </div>
      </fieldset>
    </form>
  );
}
