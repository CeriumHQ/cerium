import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { shellBridge, type Editor } from "../../backend/shell.ts";
import { editorAtom } from "../settings/preferences.ts";

/** The editors the shell found, asked for once and shared by every chip and menu that wants them. */
let listing: Promise<ReadonlyArray<Editor>> | undefined;

const listEditors = (fresh: boolean): Promise<ReadonlyArray<Editor>> => {
  const ask = shellBridge()?.editors;
  if (ask === undefined) return Promise.resolve([]);
  if (listing === undefined || fresh) listing = ask(fresh).catch(() => []);
  return listing;
};

/** The editors installed on this computer; undefined until the shell has looked, and always none without it. */
export function useEditors(fresh = false): ReadonlyArray<Editor> | undefined {
  const [editors, setEditors] = useState<ReadonlyArray<Editor>>();
  useEffect(() => {
    let current = true;
    void listEditors(fresh).then((found) => {
      if (current) setEditors(found);
    });
    return () => {
      current = false;
    };
  }, [fresh]);
  return editors;
}

/**
 * What opens a file in the editor the user chose in Settings, which is the first one found until they
 * pick. `editor` is undefined where there is none to use (no editor, the shell can't, or the user
 * chose none), so callers fall back to showing the file in the file manager.
 */
export function useEditor() {
  const editors = useEditors();
  const choice = useAtomValue(editorAtom);
  const open = shellBridge()?.openInEditor;
  const editor =
    open === undefined || choice === "none"
      ? undefined
      : (editors?.find((each) => each.id === choice) ?? editors?.[0]);
  return {
    editor,
    /** Opens `file` at `line`, in the window of the project at `folder`. */
    open:
      editor === undefined || open === undefined
        ? undefined
        : (file: string, line?: number, folder?: string) => void open(editor.id, file, line, folder),
  };
}
