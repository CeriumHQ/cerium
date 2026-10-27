import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Check } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const toneClass = {
  neutral: "border border-line-strong text-fg-primary hover:bg-surface-hover",
  primary: "bg-accent text-accent-fg hover:bg-accent-strong",
  danger: "border border-error/35 bg-error/15 text-error hover:bg-error/25",
} as const;

/** A button for a dialog's footer: `primary` for the choice most people want, `danger` for what can't be undone. */
export function DialogButton({
  tone = "neutral",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: keyof typeof toneClass }) {
  return (
    <button
      type={type}
      className={`h-8 rounded-lg px-3 text-body font-medium transition-colors disabled:opacity-40 max-md:h-10 max-md:px-4 max-md:text-[15px] ${toneClass[tone]} ${className ?? ""}`}
      {...props}
    />
  );
}

const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-line-strong bg-transparent px-2.5 text-body text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary max-md:h-10 max-md:text-[15px]";

/** A labelled field of a form dialog. */
export function DialogField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-meta text-fg-secondary max-md:text-[13px]">{label}</span>
      {children}
    </label>
  );
}

/** A text box for a form dialog. */
export function DialogInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} autoComplete="off" {...props} className={fieldClass} />;
}

/** The browser's own choice list, which is what a form with a handful of options wants. */
export function DialogSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${fieldClass} bg-surface-overlay`} />;
}

/** A tick box with its words, for a yes-or-no beside the form's other fields. */
export function DialogCheck({
  checked,
  onCheckedChange,
  children,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className="group flex cursor-default items-center gap-2 rounded-md text-left text-body text-fg-secondary outline-none select-none max-md:text-[15px]"
    >
      <span className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent group-focus-visible:border-fg-secondary">
        <Checkbox.Indicator className="text-accent-fg data-unchecked:hidden">
          <Check size={10} strokeWidth={3} />
        </Checkbox.Indicator>
      </span>
      {children}
    </Checkbox.Root>
  );
}

/**
 * A modal that asks for something: a name, a choice between what to do, or a go-ahead that isn't a
 * warning. Controlled, so a menu item can open it; Esc and the backdrop back out. `onSubmit` runs when
 * Enter is pressed in a field, as the footer's submit button does.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  aside,
  onSubmit,
  wide = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** A form with room to write in, such as an issue's description, rather than a name or a choice. */
  readonly wide?: boolean;
  /** The buttons after Cancel; a `type="submit"` one answers Enter. */
  readonly actions: ReactNode;
  /** A button for the form itself rather than its outcome, at the footer's start: "Generate". */
  readonly aside?: ReactNode;
  readonly onSubmit?: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          className={`fixed top-[calc(var(--app-top,0px)+var(--app-height,100dvh)/2)] left-1/2 ${wide ? "w-[34rem]" : "w-[24rem]"} max-h-[calc(var(--app-height,100dvh)-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain -translate-1/2 rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0`}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit?.();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Dialog.Title className="text-reading font-semibold tracking-tight max-md:text-[16px]">
                {title}
              </Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="text-body leading-relaxed text-fg-secondary max-md:text-[14px]">
                  {description}
                </Dialog.Description>
              )}
            </div>
            {children}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {aside === undefined ? null : <div className="mr-auto flex items-center">{aside}</div>}
              <Dialog.Close render={<DialogButton />}>Cancel</Dialog.Close>
              {actions}
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
