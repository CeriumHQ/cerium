import type { HighlightRequest } from "./highlight.ts";
import { createHighlightWorker } from "./highlightEngine.ts";

const receive = createHighlightWorker((response) => self.postMessage(response));
self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => receive(event.data));
