import { useAtomValue } from "@effect/atom-react";

import { machineAtom } from "../../backend/machine.ts";
import { WEB } from "../../backend/target.ts";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

/**
 * Discord Rich Presence through the Discord app on this computer (apps/backend/src/discord.ts). Off
 * until asked for, and saved by the backend. Not offered in a browser or while the window drives
 * another machine, whose Discord isn't the one in front of the user.
 */
export function DiscordSection() {
  const driven = useAtomValue(machineAtom);
  const { value, saved, save, error } = useSetting("discord", { enabled: false, showProject: false });
  if (WEB || driven !== undefined) return null;

  return (
    <SettingsSection title="Discord">
      <SettingsCard className="flex flex-col divide-y divide-line-subtle">
        <SettingsRow
          label="Show activity on Discord"
          hint="How many agents are working, and in which harnesses."
          info="Your Discord profile shows Cerium while the Discord app runs on this computer. Thread titles and messages are never shared."
          error={error}
          control={(labelledBy) => (
            <SettingsSwitch
              checked={value.enabled}
              onCheckedChange={(on) => save({ ...value, enabled: on })}
              disabled={saved === undefined}
              labelledBy={labelledBy}
            />
          )}
        />
        {value.enabled ? (
          <SettingsRow
            label="Name the project"
            hint="Adds the folder agents work in, such as “in cerium”."
            control={(labelledBy) => (
              <SettingsSwitch
                checked={value.showProject}
                onCheckedChange={(on) => save({ ...value, showProject: on })}
                disabled={saved === undefined}
                labelledBy={labelledBy}
              />
            )}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
