import type { AuthStatus } from "@cerium/protocol";

/**
 * Whose account each harness's sign-in method is, as people name it before their plan: "Claude Max",
 * "ChatGPT Plus". Methods with no plan read whole. OpenCode names its connected providers itself
 * ("Anthropic, OpenAI"), which read as they are.
 */
const accountOf: Record<string, { readonly brand: string; readonly alone: string }> = {
  "claude.ai": { brand: "Claude", alone: "Claude account" },
  chatgpt: { brand: "ChatGPT", alone: "ChatGPT account" },
  "meta.ai": { brand: "Meta", alone: "Meta account" },
  cursorLogin: { brand: "Cursor", alone: "Cursor account" },
  apiKey: { brand: "API key", alone: "API key" },
  opencodeFree: { brand: "Free models", alone: "Free models" },
};

/** A plan as it's sold: "max" is Max, "max_20x" is Max 20x. */
const planName = (plan: string) =>
  plan
    .split(/[_\s-]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** The account a signed-in harness runs on, in a word or two: "Claude Max", "API key". */
export const accountLabel = (auth: Extract<AuthStatus, { _tag: "LoggedIn" }>): string => {
  const known = auth.method === undefined ? undefined : accountOf[auth.method];
  if (auth.plan === undefined || auth.plan === "") return known?.alone ?? auth.method ?? "Signed in";
  const brand = known?.brand ?? auth.method;
  return brand === undefined ? `${planName(auth.plan)} plan` : `${brand} ${planName(auth.plan)}`;
};
