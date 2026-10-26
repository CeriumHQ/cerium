import { Accordion } from "@base-ui/react/accordion";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowUp, Check, ChevronDown, Minus, Plus, X, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Markdown } from "../transcript/Markdown.tsx";
import { EARLIER, MORE, type Change, type Kind } from "./model.ts";

const KINDS: Record<Kind, { readonly icon: LucideIcon; readonly label: string }> = {
  added: { icon: Plus, label: "New" },
  changed: { icon: ArrowUp, label: "Improved" },
  fixed: { icon: Check, label: "Fixed" },
  removed: { icon: Minus, label: "Removed" },
  other: { icon: ArrowUp, label: "Improved" },
};

/**
 * The changes in CHANGELOG.md, one headline each with its detail folded under it. The ones this
 * computer hadn't seen when the window opened come first, marked; the rest follow a page at a time.
 * It opens after an update and from the command palette and Settings → General; Esc and the backdrop
 * close it.
 */
export function WhatsNew({
  open,
  onOpenChange,
  changes,
  unseen,
  version,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly changes: ReadonlyArray<Change>;
  readonly unseen: ReadonlySet<string>;
  /** The running build's, or `dev`. */
  readonly version: string;
}) {
  const fresh = changes.filter((change) => unseen.has(change.id));
  const earlier = changes.filter((change) => !unseen.has(change.id));
  const [shown, setShown] = useState(EARLIER);
  const named = version !== "dev" ? `Cerium ${version}` : undefined;
  const summary =
    fresh.length > 0
      ? `${fresh.length} ${fresh.length === 1 ? "change" : "changes"} since you last looked${named ? `, now on ${named}` : ""}.`
      : `Everything in ${named ?? "this build"}, newest first.`;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(now) => now || setShown(EARLIER)}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 flex items-center justify-center p-2">
          <Dialog.Popup className="flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-[34rem] flex-col overflow-hidden rounded-2xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <header className="relative px-6 pt-6 pb-4">
              {/* Set as the launch screen leaves Cerium's name: the display face at its full width. */}
              <Dialog.Title
                style={{ fontStretch: "125%" }}
                className="font-display text-[1.625rem] leading-none font-semibold tracking-[0.01em] [font-size-adjust:none]"
              >
                What's new
              </Dialog.Title>
              <Dialog.Description className="mt-2.5 text-body text-fg-secondary">
                {summary}
              </Dialog.Description>
              <Dialog.Close
                aria-label="Close"
                className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                <X size={14} strokeWidth={1.75} />
              </Dialog.Close>
            </header>
            <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[min(35rem,calc(100dvh-9rem))]">
              <div className="flex flex-col gap-5 px-3 pb-4">
                {changes.length === 0 ? (
                  <p className="px-3 text-body text-fg-tertiary">This build carries no release notes.</p>
                ) : null}
                {fresh.length > 0 ? (
                  <Section title={earlier.length > 0 ? "In this update" : undefined} changes={fresh} fresh />
                ) : null}
                {earlier.length > 0 ? (
                  <Section
                    title={fresh.length > 0 ? "Earlier" : undefined}
                    changes={earlier.slice(0, shown)}
                    more={earlier.length - shown}
                    onMore={() => setShown((count) => count + MORE)}
                  />
                ) : null}
              </div>
            </ScrollArea>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({
  title,
  changes,
  fresh = false,
  more = 0,
  onMore,
}: {
  readonly title: string | undefined;
  readonly changes: ReadonlyArray<Change>;
  readonly fresh?: boolean;
  readonly more?: number;
  readonly onMore?: () => void;
}) {
  return (
    <section className="flex flex-col">
      {title ? <h3 className="px-3 pb-1.5 text-meta font-medium text-fg-tertiary">{title}</h3> : null}
      <Accordion.Root multiple className="flex flex-col">
        {changes.map((change) => (
          <Row key={change.id} change={change} fresh={fresh} />
        ))}
      </Accordion.Root>
      {more > 0 && onMore ? (
        <button
          type="button"
          onClick={onMore}
          className="mt-1 ml-3 w-fit rounded-md py-1 text-meta text-fg-secondary transition-colors hover:text-fg-primary"
        >
          Show {Math.min(more, MORE)} more
        </button>
      ) : null}
    </section>
  );
}

/** About how many characters fill a headline's two lines. */
const CLAMPED = 120;

const rowClass =
  "grid w-full grid-cols-[1rem_minmax(0,1fr)_0.875rem] items-start gap-x-3 rounded-lg px-3 py-2 text-left";

function Row({ change, fresh }: { readonly change: Change; readonly fresh: boolean }) {
  const { icon: Icon, label } = KINDS[change.kind];
  const mark = (
    <span className={`flex h-5 items-center ${fresh ? "text-accent" : "text-fg-tertiary"}`}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span className="sr-only">{label}: </span>
    </span>
  );
  // A headline past two lines folds too, so a long one without detail doesn't run on either.
  if (change.detail === undefined && change.headline.length <= CLAMPED) {
    return (
      <div className={`${rowClass} text-body leading-5 text-fg-primary`}>
        {mark}
        <span>
          <Inline text={change.headline} />
        </span>
      </div>
    );
  }
  return (
    <Accordion.Item>
      <Accordion.Header className="m-0">
        <Accordion.Trigger
          className={`group ${rowClass} text-body leading-5 text-fg-primary transition-colors hover:bg-surface-hover data-panel-open:bg-surface-hover`}
        >
          {mark}
          <span className="line-clamp-2 group-data-panel-open:line-clamp-none">
            <Inline text={change.headline} />
          </span>
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className="mt-[3px] text-fg-tertiary opacity-0 transition-[opacity,rotate] duration-200 ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 group-data-panel-open:rotate-180 group-data-panel-open:opacity-100 motion-reduce:transition-none"
          />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="h-(--accordion-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        {change.detail === undefined ? (
          <div className="pb-1" />
        ) : (
          <div className="pt-1 pr-10 pb-3 pl-10">
            <Markdown text={change.detail} streaming={false} compact />
          </div>
        )}
      </Accordion.Panel>
    </Accordion.Item>
  );
}

/** A headline's text with its `code` spans, the only markdown headlines carry. */
function Inline({ text }: { readonly text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono text-[0.92em] text-fg-primary">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
