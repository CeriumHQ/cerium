import type { AgentEvent } from "./events.ts";
import type { ThreadId } from "./ids.ts";

// Images in a tool's output, such as a screenshot an agent read. They are most of a long thread's
// bytes, so a thread's history can leave them out: each keeps its place as a reference naming its
// thread, tool call and position (`cerium-image:["<thread>","<call>",<index>]`), which the transcript
// reads on its own (`ToolImage`) when it shows the image.

/** An image in a tool's output, base64-encoded. */
export interface OutputImage {
  readonly mediaType: string;
  readonly data: string;
}

/** Where an image left out of a thread's history is read from. */
export interface ToolImageRef {
  readonly threadId: ThreadId;
  readonly callId: string;
  readonly index: number;
}

const REF = "cerium-image:";

/** Images this small stay in place: fetching one would cost more than carrying it. */
const KEPT_UNDER = 8 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An image block, as Anthropic content blocks or MCP content items carry one. */
const imageOf = (value: Record<string, unknown>) => {
  if (value["type"] !== "image") return undefined;
  const source = isRecord(value["source"]) ? value["source"] : value;
  const data = source["data"];
  const mediaType = source["media_type"] ?? source["mediaType"] ?? source["mimeType"];
  return typeof data === "string" && typeof mediaType === "string" && mediaType.startsWith("image/")
    ? { source, mediaType, data }
    : undefined;
};

/**
 * `output` with each image's data replaced by what `replace` returns for it, in the order
 * `toolOutputImages` lists them; unchanged parts stay the same objects.
 */
const mapImages = (
  output: unknown,
  replace: (image: OutputImage, index: number) => string | undefined,
): unknown => {
  let index = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 4) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const out = visit(item, depth + 1);
        if (out !== item) changed = true;
        return out;
      });
      return changed ? next : value;
    }
    if (!isRecord(value)) return value;
    const image = imageOf(value);
    if (image !== undefined) {
      const data = replace({ mediaType: image.mediaType, data: image.data }, index++);
      if (data === undefined) return value;
      return image.source === value ? { ...value, data } : { ...value, source: { ...image.source, data } };
    }
    let next: Record<string, unknown> | undefined;
    for (const key of ["content", "output", "result"]) {
      if (!(key in value)) continue;
      const out = visit(value[key], depth + 1);
      if (out !== value[key]) (next ??= { ...value })[key] = out;
    }
    return next ?? value;
  };
  return visit(output, 0);
};

/** The images in a tool's output, in order; one left out has its reference as its data. */
export const toolOutputImages = (output: unknown): ReadonlyArray<OutputImage> => {
  const found: Array<OutputImage> = [];
  mapImages(output, (image) => {
    found.push(image);
    return undefined;
  });
  return found;
};

/** The image `data` stands for, when the image was left out. */
export const toolImageRef = (data: string): ToolImageRef | undefined => {
  if (!data.startsWith(REF)) return undefined;
  try {
    const [threadId, callId, index] = JSON.parse(data.slice(REF.length)) as Array<unknown>;
    return typeof threadId === "string" &&
      typeof callId === "string" &&
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0
      ? { threadId: threadId as ThreadId, callId, index }
      : undefined;
  } catch {
    return undefined;
  }
};

/** An event with the images of its tool output left out; any other event as it is. */
export const withoutImages = (event: AgentEvent): AgentEvent => {
  const payload = event.payload;
  if (payload._tag !== "ToolCallCompleted") return event;
  const output = mapImages(payload.output, (image, index) =>
    image.data.length < KEPT_UNDER
      ? undefined
      : `${REF}${JSON.stringify([event.threadId, payload.callId, index])}`,
  );
  return output === payload.output ? event : { ...event, payload: { ...payload, output } };
};
