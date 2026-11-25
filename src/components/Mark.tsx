export type MarkKind = "owe" | "waiting" | "decision" | "overdue" | "done";

/** Item kind told apart by shape: lime square, hollow circle, diamond, red square, faded dot. */
export function Mark({ kind }: { kind: MarkKind }) {
  return <span className={`db-mark db-mark--${kind}`} aria-hidden="true" />;
}
