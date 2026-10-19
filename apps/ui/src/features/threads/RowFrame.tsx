import { Button } from "@base-ui/react/button";
import { Ellipsis } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { ContextMenuArea, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";

/**
 * What takes the place of a row's right-hand end (its age) while the "more" button shows: the button
 * covers it on hover and keyboard focus, or while a menu is open. On a touch screen the button sits
 * beside it instead, so nothing yields.
 */
export const yieldsToMore =
  "transition-opacity duration-150 md:group-hover/row:opacity-0 md:group-has-[:focus-visible]/row:opacity-0 md:group-has-[[data-popup-open]]/row:opacity-0 md:pointer-coarse:group-has-[button]/row:opacity-0";

/** Room a row keeps at its right end for the button on touch screens. */
export const moreRoom = "max-md:pr-12 pointer-coarse:pr-12";

/**
 * A row with its actions where they can be found: the right-click menu, and a "more" button that
 * opens the same menu. The button shows on hover and keyboard focus, and always on a touch screen,
 * which can't hover or right-click. `children` is the row's own button, which should use
 * `yieldsToMore` on its right end and `moreRoom` for its padding.
 */
export function RowFrame({
  label,
  menu,
  children,
}: {
  /** What the button's actions are for, such as the thread's title. */
  label: string;
  menu: ReactNode;
  children: ReactElement;
}) {
  return (
    <div className="group/row relative">
      <ContextMenuArea menu={menu}>{children}</ContextMenuArea>
      <MenuRoot>
        <MenuTrigger>
          <Button
            aria-label={`More actions for “${label}”`}
            className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 data-popup-open:bg-surface-active data-popup-open:text-fg-primary data-popup-open:opacity-100 md:group-hover/row:opacity-100 max-md:size-9 max-md:right-1.5 max-md:opacity-100 pointer-coarse:opacity-100"
          >
            <Ellipsis size={15} strokeWidth={1.75} />
          </Button>
        </MenuTrigger>
        <MenuPopup>{menu}</MenuPopup>
      </MenuRoot>
    </div>
  );
}
