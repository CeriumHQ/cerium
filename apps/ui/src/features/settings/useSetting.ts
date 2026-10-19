import type { Settings } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { settingsAtom, updateSettings } from "../../backend/atoms.ts";

/**
 * One of the settings the backend applies. The value is what was last saved, or the choice still
 * being saved, so a switch moves at once; `saved` is undefined until the backend has answered, and
 * a setting that can't be changed before then should stay disabled. `error` says why the last
 * change didn't save, until the next one.
 */
export function useSetting<K extends keyof Settings>(key: K, fallback: Settings[K]) {
  const result = useAtomValue(settingsAtom);
  const refresh = useAtomRefresh(settingsAtom);
  const update = useAtomSet(updateSettings, { mode: "promise" });
  /** The choice being saved; once saved, it shows until the settings are read back with it. */
  const [saving, setSaving] = useState<{ readonly value: Settings[K]; readonly saved: boolean }>();
  const [error, setError] = useState<string>();
  // Only the latest change speaks for the setting: an earlier one settling late changes nothing.
  const latest = useRef(0);

  if (saving?.saved && !result.waiting) setSaving(undefined);

  const saved = AsyncResult.isSuccess(result) ? result.value[key] : undefined;
  const save = (next: Settings[K]) => {
    const id = ++latest.current;
    setSaving({ value: next, saved: false });
    setError(undefined);
    update({ payload: { [key]: next } }).then(
      () => {
        if (id !== latest.current) return;
        refresh();
        setSaving({ value: next, saved: true });
      },
      () => {
        if (id !== latest.current) return;
        refresh();
        setSaving(undefined);
        setError("Couldn't save that. Is Cerium's backend running?");
      },
    );
  };
  return { value: saving ? saving.value : (saved ?? fallback), saved, save, error } as const;
}
