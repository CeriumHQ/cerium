import { commitFileOfKey, fileOfKey } from "../viewer/model.ts";

// The kinds of tab that aren't a thread's: each is named by its key, and this is where a kind is
// known. The tab strip, the session and the reopen list ask `isNonThreadKey`, so a new kind (a pull
// request, an issue) joins by adding its key reader here.

/** Whether a tab key names a tab that isn't a thread's or a draft's: a file, or a commit's file. */
export const isNonThreadKey = (key: string | undefined): boolean =>
  fileOfKey(key) !== undefined || commitFileOfKey(key) !== undefined;
