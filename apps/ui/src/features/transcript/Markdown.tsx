import { ARTIFACT_LANGUAGE } from "@cerium/artifacts";
import { Streamdown } from "streamdown";

import { Artifact } from "./Artifact.tsx";

/** Copy for code and tables; downloads don't earn a place in a conversation. */
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
} as const;

/** Agents' HTML visuals arrive as code fences in this language. */
const plugins = { renderers: [{ language: ARTIFACT_LANGUAGE, component: Artifact }] };

/** Agent-written markdown. Streamdown completes unterminated syntax while text streams and sanitizes it. */
export function Markdown({
  text,
  streaming,
  compact = false,
}: {
  text: string;
  streaming: boolean;
  /** Smaller type for markdown nested inside another block, such as a child agent's report. */
  compact?: boolean;
}) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      controls={controls}
      plugins={plugins}
      lineNumbers={false}
      className={`${compact ? "text-[13px] leading-[1.6] text-fg-secondary [&>*+*]:mt-2.5" : "text-[14px] leading-[1.65] text-fg-primary [&>*+*]:mt-3"} [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-fg-primary`}
    >
      {text}
    </Streamdown>
  );
}
