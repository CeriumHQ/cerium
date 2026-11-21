import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Check } from "lucide-react";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, SelectHTMLAttributes } from "react";
import { buttonClass, type ButtonTone } from "./Button.tsx";
import { checkMarkClass } from "./Checkbox.tsx";

/** A button for a dialog's footer: `primary` for the choice most people want, `danger` for what can't be undone. */
export function DialogButton({
  tone = "neutral",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: ButtonTone }) {
  return (
    <button type={type} className={`${buttonClass({ tone, size: "md" })} ${className ?? ""}`} {...props} />
  );
}

export const dialogBackdropClass =
  "fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0";
const dialogWidth = { sm: "w-[22rem]", md: "w-[26rem]", lg: "w-[34rem]", xl: "w-[40rem]" } as const;
/** A centred dialog's panel. Centred on the part of the page that shows (web/viewport.ts), and never taller than it. */
export const dialogPopupClass = (width: keyof typeof dialogWidth = "md") =>
  `fixed top-[calc(var(--app-top,0px)+var(--app-height,100dvh)/2)] left-1/2 ${dialogWidth[width]} max-h-[calc(var(--app-height,100dvh)-2rem)] max-w-[calc(100vw-2rem)] -translate-1/2 overflow-y-auto overscroll-contain rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0`;
export const dialogTitleClass = "text-title font-semibold tracking-tight";
export const dialogDescriptionClass = "text-body leading-relaxed text-fg-secondary max-md:text-[14px]";

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
export function DialogInput(props: ComponentProps<"input">) {
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
      <span className={checkMarkClass}>
        <Checkbox.Indicator className="data-unchecked:hidden">
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
  onClosed,
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
  /** Runs once it has finished closing, for a caller that mounts it only while it's wanted. */
  readonly onClosed?: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      {...(onClosed ? { onOpenChangeComplete: (next: boolean) => !next && onClosed() } : {})}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClass} />
        <Dialog.Popup className={dialogPopupClass(wide ? "lg" : "md")}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit?.();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Dialog.Title className={dialogTitleClass}>{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className={dialogDescriptionClass}>{description}</Dialog.Description>
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
