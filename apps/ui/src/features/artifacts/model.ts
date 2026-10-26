import { artifactId, artifactTitle, newestArtifacts } from "@cerium/artifacts";
import type { AgentEvent } from "@cerium/protocol";
import type { ListedArtifact } from "@cerium/rpc";

import { REVEAL_EVENT } from "../transcript/useStickToBottom.ts";

// What the artifacts panel lists: the pages agents drew, apart from the conversations they're in.

/** The `RPC_VERSION` that brought `ListArtifacts`; an older machine lists only the open thread's. */
export const ARTIFACTS_VERSION = 8;

/** How many of a thread's artifacts the panel lists. */
const THREAD_LIMIT = 120;

export interface PanelArtifact {
  /** The page's id, as the conversation marks it (`data-artifact-id`). */
  readonly id: string;
  readonly code: string;
  readonly title: string | undefined;
  readonly threadId: string;
  /** When the message holding it was completed. */
  readonly at: number;
}

/** The artifacts an agent drew in its completed messages, newest first, each page once. */
export const threadArtifacts = (
  events: ReadonlyArray<AgentEvent>,
  agentId: string,
): ReadonlyArray<PanelArtifact> => {
  const messages = events
    .flatMap((event) =>
      // Most messages hold none, and are passed over without being parsed.
      event.agentId === agentId &&
      event.payload._tag === "MessageCompleted" &&
      event.payload.text.includes("artifact")
        ? [{ text: event.payload.text, at: event.at, threadId: event.threadId }]
        : [],
    )
    .toReversed();
  return newestArtifacts(messages, THREAD_LIMIT).map(({ message, code, id }) => ({
    id,
    code,
    title: artifactTitle(code),
    threadId: message.threadId,
    at: message.at,
  }));
};

/** A project's artifacts as the backend lists them, for the panel. */
export const projectArtifacts = (listed: ReadonlyArray<ListedArtifact>): ReadonlyArray<PanelArtifact> =>
  listed.map(({ code, threadId, at }) => ({
    id: artifactId(code),
    code,
    title: artifactTitle(code),
    threadId,
    at,
  }));

/**
 * Brings the artifact `id` into view in the conversation showing it, ringed for a moment; waits a few
 * seconds for a conversation just opened to draw it. Resolves whether it was found.
 */
export const revealArtifact = (id: string): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = performance.now() + 4000;
    // The conversation in view, not one kept out of sight (KeptViews).
    const find = () =>
      [...document.querySelectorAll<HTMLElement>(`[data-artifact-id="${CSS.escape(id)}"]`)].find((element) =>
        element.checkVisibility(),
      );
    const look = () => {
      const found = find();
      if (found === undefined) {
        if (performance.now() > deadline) resolve(false);
        else requestAnimationFrame(look);
        return;
      }
      found.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }));
      // A short way glides there; a long one, across a long conversation, jumps at once.
      const away = Math.abs(found.getBoundingClientRect().top - window.innerHeight / 2);
      found.scrollIntoView({
        block: "center",
        behavior: away < window.innerHeight * 1.5 ? "smooth" : "instant",
      });
      found.removeAttribute("data-found");
      // Restarts the ring when the same artifact is shown again.
      void found.offsetWidth;
      found.setAttribute("data-found", "");
      // Pages above it that were still drawing push it down; once they've settled it's centred again.
      setTimeout(() => {
        const box = found.getBoundingClientRect();
        if (Math.abs(box.top + box.height / 2 - window.innerHeight / 2) > window.innerHeight / 3) {
          found.scrollIntoView({ block: "center" });
        }
      }, 700);
      setTimeout(() => found.removeAttribute("data-found"), 1700);
      resolve(true);
    };
    look();
  });
