import { createContext } from "react";

/** How the panel beside the conversation sits, for what it shows to adapt to: floating over the conversation, or not. */
export interface SidePanelLayout {
  /** The window is too narrow for it beside the conversation, so it floats over it. */
  readonly floating: boolean;
  /** Closes the panel. */
  readonly close: () => void;
}

export const SidePanelContext = createContext<SidePanelLayout>({ floating: false, close: () => undefined });
