/**
 * Cerium's mark, "Prism C": an open C with a facet in its mouth, after cerium oxide, the compound used
 * to polish glass. Below 24px a heavier drawing keeps the stroke and facet legible.
 *
 * `landing` marks the one the launch screen's mark flies to when it hands the window over: the one at
 * the top of whatever the window shows first (app/LaunchScreen.tsx). `facetClassName` styles the
 * facet on its own, as the launch screen does to turn it.
 */
export function CeriumMark({
  size = 18,
  className,
  facetClassName,
  landing = false,
}: {
  size?: number;
  className?: string;
  facetClassName?: string;
  landing?: boolean;
}) {
  const small = size < 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      data-launch-mark={landing ? "" : undefined}
      className={`shrink-0 ${className ?? ""}`}
    >
      <path
        d="M34.6 13.4A15 15 0 1 0 34.6 34.6"
        stroke="currentColor"
        strokeWidth={small ? 7 : 6}
        strokeLinecap="round"
      />
      <path
        d={small ? "M36 18.5 41.5 24 36 29.5 30.5 24Z" : "M36 19.5 40.5 24 36 28.5 31.5 24Z"}
        fill="currentColor"
        className={facetClassName}
      />
    </svg>
  );
}
