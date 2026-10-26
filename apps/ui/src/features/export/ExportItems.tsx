import { ClipboardCopy, FileDown, FileText, Share } from "lucide-react";

import { MenuItem, MenuSubmenu } from "../../components/ui/Menu.tsx";
import { useThreadExport } from "./useThreadExport.ts";

/**
 * A thread's export for its menu, folded into one Export item: a Markdown or text file to save, or
 * the Markdown on the clipboard.
 */
export function ExportMenuItems({ threadId }: { readonly threadId: string }) {
  const exportThread = useThreadExport();
  return (
    <MenuSubmenu icon={Share} label="Export">
      <MenuItem icon={FileDown} onClick={() => void exportThread(threadId, "markdown")}>
        Markdown file…
      </MenuItem>
      <MenuItem icon={FileText} onClick={() => void exportThread(threadId, "text")}>
        Text file…
      </MenuItem>
      <MenuItem icon={ClipboardCopy} onClick={() => void exportThread(threadId, "copy")}>
        Copy as Markdown
      </MenuItem>
    </MenuSubmenu>
  );
}
