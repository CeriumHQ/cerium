import { useEffect, useState, type ReactNode } from "react";

// LaTeX math in a reply, drawn as MathML by Temml, which loads the first time a reply has math in it
// and costs nothing before. Temml is small and fast enough to draw in the render itself once loaded,
// so a block that mounts again (scrolling back through a long thread) never shows its source first.

type Temml = (typeof import("temml"))["default"];

let loaded: Temml | undefined;
let loading: Promise<Temml> | undefined;

const loadTemml = (): Promise<Temml> => {
  loading ??= Promise.all([import("temml"), import("temml/dist/Temml-Local.css")]).then(([module]) => {
    loaded = module.default;
    return module.default;
  });
  return loading;
};

/** The MathML for `source`, or why it doesn't parse. */
const draw = (temml: Temml, source: string, display: boolean): string | undefined => {
  try {
    return temml.renderToString(source, { displayMode: display, throwOnError: true });
  } catch {
    return undefined;
  }
};

/**
 * `source` as math: inline in a line of prose, or `display`ed on a line of its own. While its block is
 * still being written a formula that doesn't parse yet keeps the last one that did, so half of
 * `\frac{a}{b}` never flashes as an error; once the block is whole, one that still doesn't parse is
 * shown as `fallback`, its source.
 */
export function Formula({
  source,
  display,
  unfinished,
  fallback,
}: {
  source: string;
  display: boolean;
  /** Its block is still being written. */
  unfinished: boolean;
  fallback: ReactNode;
}) {
  const [temml, setTemml] = useState(loaded);
  const [kept, setKept] = useState<string>();
  useEffect(() => {
    if (temml === undefined) void loadTemml().then(setTemml);
  }, [temml]);

  const drawn = temml === undefined ? undefined : draw(temml, source.trim(), display);
  if (drawn !== undefined && drawn !== kept) setKept(drawn);
  const html = drawn ?? (unfinished ? kept : undefined);

  if (html === undefined) {
    // Not loaded or not written yet: its source, held in place; the fallback once nothing more comes.
    if (temml !== undefined && !unfinished) return fallback;
    return display ? (
      <div data-md="math-display" className="min-h-[2.4em]" />
    ) : (
      <span className="text-fg-tertiary">{source}</span>
    );
  }
  return display ? (
    <div
      data-md="math-display"
      className="scroll-thin overflow-x-auto py-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span data-md="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
