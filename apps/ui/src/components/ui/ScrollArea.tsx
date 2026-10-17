import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, Ref } from "react";

/** A vertical scroll area whose thin scrollbar only appears while hovering or scrolling. */
export function ScrollArea({
  className,
  viewportRef,
  children,
}: {
  className?: string;
  /** The scrolling element, for callers that manage the scroll position. */
  viewportRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <BaseScrollArea.Root className={`relative min-h-0 ${className ?? ""}`}>
      <BaseScrollArea.Viewport ref={viewportRef} className="h-full overscroll-contain">
        {/* Content defaults to `min-width: fit-content` for horizontal scrolling; vertical lists must
            fit the viewport so their rows can truncate. */}
        <BaseScrollArea.Content className="min-w-0!">{children}</BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className="pointer-events-none m-0.5 flex w-1.5 justify-center rounded-full opacity-0 transition-opacity duration-300 data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-0">
        <BaseScrollArea.Thumb className="w-full rounded-full bg-fg-tertiary/40" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
