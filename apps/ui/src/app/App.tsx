import { RegistryProvider, useAtomValue } from "@effect/atom-react";
import { type ReactNode } from "react";

import { TooltipProvider } from "../components/ui/Tooltip.tsx";
import { themeAtom } from "../features/settings/preferences.ts";
import { useScale, useWindowSolid } from "../features/settings/scale.ts";
import { useTheme } from "../features/settings/theme.ts";
import { WebGate } from "../web/WebGate.tsx";
import { Launch } from "./LaunchScreen.tsx";
import { TextMenu } from "./TextMenu.tsx";
import { useSharedPreferences } from "./threadWindow.ts";

import { Workspace } from "./Workspace.tsx";

export function App() {
  return (
    <RegistryProvider>
      <TooltipProvider delay={400}>
        <Themed>
          <Launch>
            <WebGate>
              <Workspace />
            </WebGate>
          </Launch>
        </Themed>
        <TextMenu />
      </TooltipProvider>
    </RegistryProvider>
  );
}

/** Keeps the page on the chosen theme and scale, the web client's sign-in included. */
function Themed({ children }: { children: ReactNode }) {
  useTheme(useAtomValue(themeAtom));
  useScale();
  useWindowSolid();
  useSharedPreferences();
  return children;
}
