/** Where a book stands, counted from its knowledge base and its translation as they are now. */
export interface BookCounts {
  entries: number;
  openQuestions: number;
  /** Passages translated, yours included. */
  passages: number;
  /** Passages flagged or refused. */
  attention: number;
  /** Passages not translated yet. */
  pending: number;
}

export interface PairCounts {
  entries: number;
  styleRules: number;
}

/** Counts for the lists that say where a project's books and pairs stand. */
export interface ProjectOverview {
  books: Record<string, BookCounts>;
  pairs: Record<string, PairCounts>;
}
