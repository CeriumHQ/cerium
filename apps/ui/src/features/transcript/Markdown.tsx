import { Streamdown } from "streamdown";

/** Copy for code and tables; downloads don't earn a place in a conversation. */
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
} as const;

/** Agent-written markdown. Streamdown completes unterminated syntax while text streams and sanitizes it. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      controls={controls}
      lineNumbers={false}
      className="text-[14px] leading-[1.65] text-fg-primary [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-fg-primary [&>*+*]:mt-3"
    >
      {text}
    </Streamdown>
  );
}
