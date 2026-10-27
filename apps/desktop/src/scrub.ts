import type { ErrorEvent } from "@sentry/electron/main";

// What a crash report may carry, applied to every event as the last step before it leaves the
// machine (crashReports.ts). Reports are anonymous: no user, machine name, IP, request, breadcrumbs or
// local variables; messages lose paths, addresses, emails and anything shaped like an id or a secret;
// stack frames keep only where in Cerium's own files they ran. What the user said, the agents wrote,
// or their projects are called never belongs in one.

/** The longest message a report keeps, after redaction. */
const MESSAGE_LIMIT = 300;
/** The longest value of a tag or of the failure's context. */
const VALUE_LIMIT = 64;

/** Tags a report may carry: Sentry's own `event.*` ones, and these. */
const TAGS: ReadonlySet<string> = new Set([
  "process",
  "category",
  "kind",
  "channel",
  "harness",
  "phase",
  "code",
]);
/** The failure context keys a report may carry, besides the tags. */
export const CONTEXT_KEYS: ReadonlySet<string> = new Set(["harness", "phase", "code", "status", "view"]);
/** What of each context a report keeps: versions, the system and the processor, nothing that names the machine. */
const CONTEXTS: Readonly<Record<string, ReadonlySet<string>>> = {
  os: new Set(["name", "version"]),
  device: new Set(["arch"]),
  app: new Set(["app_version", "app_name"]),
  runtime: new Set(["name", "version"]),
  electron: new Set(["name", "version", "type"]),
  chrome: new Set(["name", "version", "type"]),
  node: new Set(["name", "version", "type"]),
  cerium: CONTEXT_KEYS,
};

/** A quoted run of text that reads like words, not an identifier. */
const QUOTED = /(["'`])((?:(?!\1).){2,}?)\1/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/** A Windows path: a drive or a share, then folders that may have spaces, then a name that may not. */
const WINDOWS_PATH = /(?:\b[A-Za-z]:|\\\\[^\\\s]+)[\\/](?:[^\\/\r\n:*?"<>|]+[\\/])*[^\\/\r\n:*?"<>|\s'`)]*/g;
/** A POSIX path of at least two parts, not part of a word. */
const POSIX_PATH = /(?<![\w.~])(?:~|\/)(?:\/?[^/\s'"`:)]+){2,}/g;
/** Letters and digits together, long enough to be an id, a hash or a secret. */
const TOKEN = /\b[A-Za-z0-9_-]{20,}\b/g;

const looksLikeToken = (text: string) => /\d/.test(text) && /[A-Za-z]/.test(text);

/** `text` without paths, addresses, emails, ids or quoted prose, at most `limit` characters. */
export const redact = (text: string, limit = MESSAGE_LIMIT): string => {
  const redacted = text
    .replace(URL_PATTERN, "<url>")
    .replace(EMAIL, "<email>")
    .replace(WINDOWS_PATH, "<path>")
    .replace(POSIX_PATH, "<path>")
    .replace(IPV4, "<ip>")
    .replace(TOKEN, (match) => (looksLikeToken(match) ? "<id>" : match))
    // An identifier in quotes says which property or option failed; anything with spaces or longer
    // may be what someone wrote.
    .replace(QUOTED, (match, quote: string, inner: string) =>
      /\s/.test(inner) || inner.length > 40 ? `${quote}…${quote}` : match,
    );
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
};

/** Where a stack frame ran, as a path inside Cerium's own install, or only the file's name. */
export const appPath = (path: string): string => {
  const normal = path.replace(/\\/g, "/").replace(/^file:\/\/\/?/, "/");
  if (normal.startsWith("app:///")) return normal;
  for (const root of ["/resources/app/", "/resources/", "/apps/desktop/", "/Contents/Resources/app/"]) {
    const at = normal.lastIndexOf(root);
    if (at !== -1) return `app:///${normal.slice(at + root.length)}`;
  }
  const modules = normal.lastIndexOf("/node_modules/");
  if (modules !== -1) return `app:///${normal.slice(modules + 1)}`;
  return normal.split("/").pop() ?? "";
};

const pick = (
  record: Record<string, unknown> | undefined,
  keys: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
  if (record === undefined) return undefined;
  const kept = Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => keys.has(key) && ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, typeof value === "string" ? redact(value, VALUE_LIMIT) : value]),
  );
  return Object.keys(kept).length === 0 ? undefined : kept;
};

/** The event as it may leave the machine: every field not listed here is dropped. */
export const scrubEvent = (event: ErrorEvent): ErrorEvent => {
  const tags = Object.fromEntries(
    Object.entries(event.tags ?? {})
      .filter(([key]) => TAGS.has(key) || key.startsWith("event."))
      .map(([key, value]) => [key, typeof value === "string" ? redact(value, VALUE_LIMIT) : value]),
  );
  const contexts = Object.fromEntries(
    Object.entries(CONTEXTS)
      .map(([name, keys]) => [
        name,
        pick(event.contexts?.[name] as Record<string, unknown> | undefined, keys),
      ])
      .filter(([, context]) => context !== undefined),
  );
  const exceptions = event.exception?.values?.map((exception) => ({
    ...(exception.type === undefined ? {} : { type: redact(exception.type, VALUE_LIMIT) }),
    ...(exception.value === undefined ? {} : { value: redact(exception.value) }),
    ...(exception.mechanism === undefined
      ? {}
      : { mechanism: { type: exception.mechanism.type, handled: exception.mechanism.handled ?? false } }),
    ...(exception.stacktrace?.frames === undefined
      ? {}
      : {
          stacktrace: {
            frames: exception.stacktrace.frames.map((frame) => ({
              ...(frame.filename === undefined ? {} : { filename: appPath(frame.filename) }),
              // A function's name is code's, such as Effect's `~effect/Effect/args`, which reads like a path.
              ...(frame.function === undefined ? {} : { function: frame.function.slice(0, 120) }),
              ...(frame.lineno === undefined ? {} : { lineno: frame.lineno }),
              ...(frame.colno === undefined ? {} : { colno: frame.colno }),
              ...(frame.in_app === undefined ? {} : { in_app: frame.in_app }),
            })),
          },
        }),
  }));
  return {
    type: undefined,
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.level === undefined ? {} : { level: event.level }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.release === undefined ? {} : { release: event.release }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.sdk === undefined ? {} : { sdk: event.sdk }),
    ...(event.fingerprint === undefined
      ? {}
      : { fingerprint: event.fingerprint.map((part) => redact(part, VALUE_LIMIT)) }),
    ...(event.message === undefined ? {} : { message: redact(event.message) }),
    ...(exceptions === undefined ? {} : { exception: { values: exceptions } }),
    tags,
    contexts,
  };
};
