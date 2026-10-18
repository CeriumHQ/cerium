import { CeriumMark } from "../components/CeriumMark.tsx";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Where a new thread starts: what the first message will do, above the composer. */
export function EmptyThread({ mode, folder }: { mode: "work" | "chat"; folder: string | undefined }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 pb-32 text-center">
      <CeriumMark size={36} className="text-fg-disabled" />
      <h1 className="text-[17px] font-medium tracking-tight text-fg-primary">
        {mode === "work" ? "What should we work on?" : "What would you like to know?"}
      </h1>
      <p className="max-w-sm text-[13px] leading-relaxed text-fg-tertiary">
        {mode === "chat"
          ? "Chats can read and search the web, and never change your files."
          : folder
            ? `Agents will work in ${baseName(folder)}. Pick a model, then describe the task.`
            : "Choose a project for the agents to work in, pick a model, then describe the task."}
      </p>
    </div>
  );
}
