/** Token counts for dense rows: "870", "1.2k", "157k". */
export const compactTokens = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : `${value}`;

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
