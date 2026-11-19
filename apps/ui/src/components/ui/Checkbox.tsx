/** The box of a tick box. Put it inside a `group` (the Checkbox.Root or its label) so it follows that element's state. */
export const checkMarkClass =
  "grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong text-accent-fg transition-colors group-data-checked:border-accent group-data-checked:bg-accent group-data-indeterminate:border-accent group-data-indeterminate:bg-accent group-focus-visible:ring-2 group-focus-visible:ring-focus-ring group-data-disabled:opacity-40";
/** The same box when the Checkbox.Root is the box itself. */
export const checkBoxClass =
  "grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-line-strong text-accent-fg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent data-disabled:opacity-40";
