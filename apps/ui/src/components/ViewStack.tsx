import type { ReactNode } from "react";

/**
 * Views stacked in one place, showing only the active one. The others stay mounted, hidden and inert,
 * so coming back to one finds it as it was left: same scroll position, same open groups, same draft.
 * Views listed before the active one slide out to the left, later ones to the right.
 */
export function ViewStack<K extends string>({
  active,
  views,
}: {
  active: K;
  views: ReadonlyArray<readonly [key: K, view: ReactNode]>;
}) {
  const activeIndex = views.findIndex(([key]) => key === active);
  return (
    <div className="grid h-full grid-cols-1 grid-rows-1">
      {views.map(([key, view], index) => (
        <div
          key={key}
          inert={index !== activeIndex}
          // Only a view that hides delays its visibility, so it can fade out; the one that shows is
          // visible at once, so it can take focus straight away.
          className={`col-start-1 row-start-1 min-h-0 min-w-0 duration-200 ease-out-soft motion-reduce:transition-none ${
            index === activeIndex
              ? "visible translate-x-0 opacity-100 transition-[opacity,translate]"
              : `invisible opacity-0 transition-[opacity,translate,visibility] ${
                  index < activeIndex ? "-translate-x-2" : "translate-x-2"
                }`
          }`}
        >
          {view}
        </div>
      ))}
    </div>
  );
}
