/** Kept per agent (or CLI session), never across agents that have not seen the image. */
export interface ReviewState {
  readonly entries: Record<
    string,
    {
      rounds: number;
      hash: string;
      capture: string;
      checks: string[];
    }
  >;
}

export interface ReviewRequest {
  readonly session: string;
  readonly state?: string | undefined;
  readonly defect?: string | undefined;
  readonly fix?: string | undefined;
}

export class ReviewLedger {
  readonly state: ReviewState;
  constructor(state: ReviewState = { entries: {} }) {
    this.state = state;
  }

  check(key: string, review: Pick<ReviewRequest, "defect" | "fix">): string | undefined {
    const previous = this.state.entries[key];
    if (previous === undefined || previous.rounds < 2) return;
    const defect = review.defect?.trim();
    const fix = review.fix?.trim();
    if (!defect || !fix) {
      return `Two visual reviews already covered this target/state (${previous.capture}). Batch fixes before another capture; name the unresolved defect and the fix to verify if another review is necessary.`;
    }
    if (previous.checks.includes(JSON.stringify([defect, fix]))) {
      return `That defect/fix was already reviewed in ${previous.capture}. Reuse the capture or identify a different unresolved defect.`;
    }
  }

  record(
    key: string,
    hash: string,
    capture: string,
    review: Pick<ReviewRequest, "defect" | "fix"> = {},
  ): {
    readonly changed: boolean;
    readonly capture: string;
    readonly rounds: number;
  } {
    const previous = this.state.entries[key];
    if (previous?.hash === hash)
      return { changed: false, capture: previous.capture, rounds: previous.rounds };
    const entry = {
      rounds: (previous?.rounds ?? 0) + 1,
      hash,
      capture,
      checks: [...(previous?.checks ?? [])],
    };
    if (review.defect?.trim() && review.fix?.trim()) {
      entry.checks.push(JSON.stringify([review.defect.trim(), review.fix.trim()]));
    }
    this.state.entries[key] = entry;
    return { changed: true, capture, rounds: entry.rounds };
  }
}
