import { ClipboardCopy, FileDown, FileText } from "lucide-react";

import { MenuItem } from "../../components/ui/Menu.tsx";
import { useThreadExport } from "./useThreadExport.ts";

/** A thread's export items for its menu: a Markdown or text file to save, or the Markdown on the clipboard. */
export function ExportMenuItems({ threadId }: { readonly threadId: string }) {
  const exportThread = useThreadExport();
  return (
    <>
      <MenuItem icon={FileDown} onClick={() => void exportThread(threadId, "markdown")}>
        Export as Markdown…
      </MenuItem>
      <MenuItem icon={FileText} onClick={() => void exportThread(threadId, "text")}>
        Export as text…
      </MenuItem>
      <MenuItem icon={ClipboardCopy} onClick={() => void exportThread(threadId, "copy")}>
        Copy as Markdown
      </MenuItem>
    </>
  );
}
