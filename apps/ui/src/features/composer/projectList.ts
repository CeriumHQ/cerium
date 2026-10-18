// How the project picker names, places and finds a saved project folder.

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean);

/** The folder's own name: what the picker and the inbox call the project. */
export const projectName = (path: string): string => segments(path).at(-1) ?? path;

/**
 * Where the folder sits, short enough for a list row: the folders above it, or just the nearest two
 * when there are more ("…\Projects\Apps"). Uses the path's own separator.
 */
export const projectPlace = (path: string): string => {
  const separator = path.includes("\\") ? "\\" : "/";
  const above = segments(path).slice(0, -1);
  if (above.length <= 3) {
    const joined = above.join(separator);
    // A drive letter alone ("C:") reads better with its separator; a POSIX path starts at the root.
    return path.startsWith("/") ? `/${joined}` : above.length === 1 ? `${joined}${separator}` : joined;
  }
  return `…${separator}${above.slice(-2).join(separator)}`;
};

const normalize = (text: string) => text.toLowerCase().replaceAll("\\", "/");

/**
 * The projects that match what's typed, best first: names that start with it, names that contain it,
 * then folders whose path holds every word typed. Each group keeps the list's own order.
 */
export const rankProjects = (paths: ReadonlyArray<string>, query: string): ReadonlyArray<string> => {
  const typed = normalize(query.trim());
  if (typed === "") return paths;
  const words = typed.split(/\s+/);
  const rank = (path: string) => {
    const name = normalize(projectName(path));
    if (name.startsWith(typed)) return 0;
    if (name.includes(typed)) return 1;
    const haystack = normalize(path);
    return words.every((word) => haystack.includes(word)) ? 2 : undefined;
  };
  return paths
    .flatMap((path) => {
      const score = rank(path);
      return score === undefined ? [] : [{ path, score }];
    })
    .sort((a, b) => a.score - b.score)
    .map(({ path }) => path);
};
