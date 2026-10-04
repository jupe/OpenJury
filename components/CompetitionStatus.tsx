const labels: Record<string, string> = {
  draft: "Draft",
  submission: "Open for entries",
  voting: "Voting",
  review_pending: "In review",
  completed: "Results published",
};

const styles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submission: "bg-emerald-100 text-emerald-800",
  voting: "bg-indigo-100 text-indigo-800",
  review_pending: "bg-amber-100 text-amber-800",
  completed: "bg-sky-100 text-sky-800",
};

export function statusLabel(status: string) {
  return labels[status] ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${styles[status] ?? styles.draft}`}>
      {statusLabel(status)}
    </span>
  );
}

/**
 * The admin's next manual step in the lifecycle enforced by
 * transition_competition. Review is finished by publishing results instead.
 */
export const nextTransition: Record<string, { target: string; action: string; confirm: string }> = {
  draft: {
    target: "submission",
    action: "Open submissions",
    confirm: "Open submissions? Members can then submit entries, and the draft can no longer be edited.",
  },
  submission: {
    target: "voting",
    action: "Close submissions and start voting",
    confirm: "Close submissions and start voting? Entries are numbered for blind voting and can no longer be changed.",
  },
  voting: {
    target: "review_pending",
    action: "Close voting",
    confirm: "Close voting? Ballots can no longer be changed, and you can review results before publishing them.",
  },
};
