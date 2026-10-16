import { Streamdown } from "streamdown";

/** Agent-written markdown. Streamdown completes unterminated syntax while text streams and sanitizes it. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      className="text-[14px] leading-[1.65] text-fg-primary [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-fg-primary [&>*+*]:mt-3"
    >
      {text}
    </Streamdown>
  );
}
