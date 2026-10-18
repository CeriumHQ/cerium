import { fileIconSvg, skillIconSvg } from "./fileIcons/index.ts";

/** A file type's icon (Material Icon Theme), or a skill's. The markup is Cerium's own bundled SVG. */
export function FileIcon({
  path,
  folder = false,
  skill = false,
  className = "size-3.5",
}: {
  path?: string;
  folder?: boolean;
  skill?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-grid shrink-0 place-items-center [&>svg]:size-full ${className}`}
      // Static icons generated from a vetted set, never from user or agent input.
      dangerouslySetInnerHTML={{ __html: skill ? skillIconSvg() : fileIconSvg(path ?? "", folder) }}
    />
  );
}
