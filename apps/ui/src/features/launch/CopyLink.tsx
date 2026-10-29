import { Link } from "lucide-react";

import { MenuItem } from "../../components/ui/Menu.tsx";
import { copyText } from "../transcript/menus.ts";

/** The link that opens a thread in Cerium on the computer it lives on, for notes and pull requests. */
export const threadLink = (threadId: string): string => `cerium://thread/${threadId}`;

/** A thread's menu item that copies its `cerium://` link. */
export function CopyLinkMenuItem({ threadId }: { readonly threadId: string }) {
  return (
    <MenuItem icon={Link} onClick={() => copyText(threadLink(threadId))}>
      Copy link
    </MenuItem>
  );
}
