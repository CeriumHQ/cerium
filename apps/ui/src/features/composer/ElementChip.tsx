import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { imageAtom } from "../../backend/files.ts";
import { Button } from "@base-ui/react/button";
import { ChevronRight, ImageOff } from "lucide-react";
import { useId, useState } from "react";

import { Reveal } from "../../components/Reveal.tsx";
import type { DraftComment } from "./draft.ts";

/** The element a comment was pointed at in the preview. */
export type PickedElement = NonNullable<DraftComment["element"]>;

const size = (element: PickedElement) => `${Math.round(element.width)}×${Math.round(element.height)}`;

/** The page's address without its scheme, for a line of metadata. */
const where = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
};

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-fg-tertiary">{name}</dt>
      <dd className="min-w-0 flex-1 font-mono break-words text-fg-secondary">{children}</dd>
    </div>
  );
}

/**
 * What a comment points at in the preview, as a chip: the element's screenshot, its tag and where it
 * sits, opening into the details the agent will receive.
 */
export function ElementChip({ element }: { element: PickedElement }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const panel = useId();
  const styles = Object.entries(element.styles);
  const image = useAtomValue(imageAtom(element.screenshot.path));
  const shot = AsyncResult.isSuccess(image) && !broken ? image.value : undefined;
  const detail = [element.component, element.source].filter((part) => part !== undefined && part !== "");

  return (
    <div className="mt-1 mb-0.5 rounded-md bg-surface-sunken">
      <Button
        aria-expanded={open}
        aria-controls={panel}
        aria-label={`${open ? "Hide" : "Show"} details of ${element.tag}`}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md p-1 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="grid h-8 w-11 shrink-0 place-items-center overflow-hidden rounded bg-surface-pane ring-1 ring-line-subtle">
          {shot ? (
            <img src={shot} alt="" onError={() => setBroken(true)} className="h-full w-full object-contain" />
          ) : (
            <ImageOff size={13} strokeWidth={1.5} className="text-fg-disabled" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5 text-meta">
            <span className="shrink-0 font-mono text-fg-primary">&lt;{element.tag}&gt;</span>
            <span className="shrink-0 text-fg-tertiary tabular-nums">{size(element)}</span>
          </span>
          <span className="block truncate font-mono text-[11px] text-fg-tertiary" title={element.selector}>
            {element.selector}
          </span>
        </span>
        <ChevronRight
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          className={`mr-1 shrink-0 text-fg-tertiary transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </Button>
      <Reveal>
        {open ? (
          <div id={panel} className="px-2 pt-1 pb-2">
            {shot ? (
              <div className="relative mb-2 overflow-hidden rounded bg-surface-pane ring-1 ring-line-subtle">
                <img
                  src={shot}
                  alt={`Screenshot of ${element.tag}`}
                  className="mx-auto block max-h-40 max-w-full object-contain"
                />
              </div>
            ) : null}
            <dl className="flex flex-col gap-1 text-[11px] leading-snug">
              <Row name="Selector">{element.selector}</Row>
              <Row name="Page">{where(element.url)}</Row>
              <Row name="Size">{size(element)}</Row>
              {detail.length > 0 ? <Row name="Source">{detail.join(" · ")}</Row> : null}
            </dl>
            {styles.length > 0 ? (
              <details className="mt-1.5 text-[11px]">
                <summary className="cursor-default text-fg-tertiary select-none hover:text-fg-secondary">
                  Styles ({styles.length})
                </summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono">
                  {styles.map(([name, value]) => (
                    <div key={name} className="contents">
                      <dt className="text-fg-tertiary">{name}</dt>
                      <dd className="min-w-0 break-words text-fg-secondary">{value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
            {element.html !== "" ? (
              <details className="mt-1.5 text-[11px]">
                <summary className="cursor-default text-fg-tertiary select-none hover:text-fg-secondary">
                  HTML
                </summary>
                <pre className="mt-1 max-h-28 overflow-auto rounded bg-surface-pane p-1.5 font-mono whitespace-pre-wrap break-all text-fg-secondary">
                  {element.html}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </Reveal>
    </div>
  );
}
