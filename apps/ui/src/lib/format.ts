/** One decimal below 10 ("1.2", "1" rather than "1.0"), whole numbers above. */
const scaled = (value: number) => (value < 9.95 ? `${Number(value.toFixed(1))}` : value.toFixed(0));

/** Token counts for dense rows: "870", "1.2k", "157k", "1.1M". */
export const compactTokens = (value: number): string =>
  value >= 999_500
    ? `${scaled(value / 1_000_000)}M`
    : value >= 1000
      ? `${scaled(value / 1000)}k`
      : `${value}`;

/** Dollars to the cent; a cheap turn that still cost something never reads as free. */
export const usd = (value: number): string => (value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`);

/** Markdown flattened to one line of plain text, for previews that clamp a few lines. */
export const plainExcerpt = (markdown: string): string =>
  markdown
    .replace(/^```.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
