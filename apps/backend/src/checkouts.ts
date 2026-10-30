import type { CheckoutInfo, ThreadInfo } from "@cerium/protocol";
import { checkoutId } from "./worktree.ts";

/** NUL fields keep spaces, quotes and newlines in checkout paths literal. */
export const parseCheckouts = (
  output: string,
  threads: ReadonlyArray<ThreadInfo>,
): ReadonlyArray<CheckoutInfo> => {
  const found: Array<CheckoutInfo> = [];
  let path = "",
    branch = "",
    head = "",
    detached = false;
  const finish = () => {
    if (path !== "")
      found.push({
        id: checkoutId(path),
        path,
        branch,
        head,
        detached,
        threads: threads
          .filter((thread) => insideCheckout(path, thread.worktree?.root ?? thread.cwd ?? ""))
          .map((thread) => ({ id: thread.id, title: thread.title, active: thread.archivedAt === undefined })),
      });
    path = "";
    branch = "";
    head = "";
    detached = false;
  };
  for (const field of output.split("\0")) {
    if (field === "") finish();
    else if (field.startsWith("worktree ")) path = field.slice(9);
    else if (field.startsWith("HEAD ")) head = field.slice(5);
    else if (field.startsWith("branch ")) branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (field === "detached") detached = true;
  }
  finish();
  return found;
};

const normal = (value: string) => {
  const path = value.replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
export const sameCheckout = (left: string, right: string) => normal(left) === normal(right);
export const insideCheckout = (root: string, folder: string) =>
  root !== "" &&
  folder !== "" &&
  (sameCheckout(root, folder) || normal(folder).startsWith(`${normal(root)}/`));
