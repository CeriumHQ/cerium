import { AppFrame } from "./AppFrame.tsx";

export function App() {
  return (
    <AppFrame sidebar={<Placeholder label="Threads" />} inspector={<Placeholder label="Agents" />}>
      <Placeholder label="Conversation" />
    </AppFrame>
  );
}

function Placeholder({ label }: { label: string }) {
  return <div className="grid h-full place-items-center text-sm text-fg-tertiary">{label}</div>;
}
