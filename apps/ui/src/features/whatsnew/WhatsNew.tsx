import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useState } from "react";

import changelog from "../../../../../CHANGELOG.md?raw";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Markdown } from "../transcript/Markdown.tsx";
import { hiddenCount, parseChangelog, releaseMarkdown, releaseTitle, RELEASES } from "./model.ts";

const releases = parseChangelog(changelog).slice(0, RELEASES);

/**
 * The newest entries of CHANGELOG.md, newest release first, in a dialog. It opens after an update
 * and from the command palette and Settings → General; Esc and the backdrop close it.
 */
export function WhatsNew({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 flex items-center justify-center p-2">
          <Dialog.Popup className="flex max-h-[min(40rem,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
              <Dialog.Title className="text-[14px] font-semibold tracking-tight">What's new</Dialog.Title>
              <Dialog.Close
                aria-label="Close"
                className="flex size-7 items-center justify-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                <X size={14} strokeWidth={1.75} />
              </Dialog.Close>
            </div>
            <ScrollArea className="flex-1" viewportClassName="max-h-[min(36.5rem,calc(100dvh-5.5rem))]">
              <div className="flex flex-col gap-6 px-5 py-4">
                {releases.length === 0 ? (
                  <p className="text-[13px] text-fg-tertiary">No release notes in this build.</p>
                ) : (
                  releases.map((release) => {
                    const hidden = hiddenCount(release);
                    const all = expanded.has(release.title);
                    return (
                      <section key={release.title} className="flex flex-col gap-2">
                        <h2 className="flex items-baseline gap-2 text-[14px] font-semibold tracking-tight">
                          {releaseTitle(release)}
                          {release.date ? (
                            <span className="text-[12px] font-normal text-fg-tertiary">{release.date}</span>
                          ) : null}
                        </h2>
                        <div className="[&_[data-streamdown=heading-3]]:mt-4! [&_[data-streamdown=heading-3]]:mb-1.5! [&_[data-streamdown=heading-3]]:text-[11.5px]! [&_[data-streamdown=heading-3]]:font-medium! [&_[data-streamdown=heading-3]]:tracking-wide [&_[data-streamdown=heading-3]]:text-fg-tertiary! [&_[data-streamdown=heading-3]]:uppercase">
                          <Markdown text={releaseMarkdown(release, all)} streaming={false} compact />
                        </div>
                        {hidden > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              setExpanded((current) => {
                                const next = new Set(current);
                                if (all) next.delete(release.title);
                                else next.add(release.title);
                                return next;
                              })
                            }
                            className="w-fit rounded-md text-[12.5px] text-fg-secondary transition-colors hover:text-fg-primary"
                          >
                            {all ? "Show fewer" : `Show ${hidden} earlier`}
                          </button>
                        ) : null}
                      </section>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
