"use client";

import { useLocale } from "@/lib/i18n";

const labels: Record<string, string> = {
  draft: "Draft",
  submission: "Open for entries",
  voting: "Voting",
  review_pending: "In review",
  results_published: "Results published",
};

const styles: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submission: "bg-emerald-100 text-emerald-800",
  voting: "bg-indigo-100 text-indigo-800",
  review_pending: "bg-amber-100 text-amber-800",
  results_published: "bg-golden text-charcoal",
};

export function statusLabel(status: string) {
  return labels[status] ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLocale();
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${styles[status] ?? styles.draft}`}>
      {t(statusLabel(status))}
    </span>
  );
}

/**
 * The admin's next manual step in the lifecycle enforced by
 * transition_competition. Review is finished by publishing results instead.
 */
export const nextTransition: Record<string, { target: string; action: string; confirm: string; error: string }> = {
  draft: {
    target: "submission",
    action: "Open submissions",
    error: "Unable to open submissions: {error}",
    confirm: "Open submissions? Members can then submit entries, and the draft can no longer be edited.",
  },
  submission: {
    target: "voting",
    action: "Close submissions and start voting",
    error: "Unable to close submissions and start voting: {error}",
    confirm: "Close submissions and start voting? Entries are numbered for blind voting and can no longer be changed.",
  },
  voting: {
    target: "review_pending",
    action: "Close voting",
    error: "Unable to close voting: {error}",
    confirm: "Close voting? Ballots can no longer be changed, and you can review results before publishing them.",
  },
};

export const previousTransition: Record<string, { target: string; action: string; confirm: string; error: string }> = {
  submission: {
    target: "draft",
    action: "Return to draft",
    error: "Unable to return competition to draft: {error}",
    confirm: "Return this competition to draft? Members will no longer be able to submit entries.",
  },
  voting: {
    target: "submission",
    action: "Reopen submissions",
    error: "Unable to reopen submissions: {error}",
    confirm: "Reopen submissions? This is only available before any votes have been cast.",
  },
  review_pending: {
    target: "voting",
    action: "Reopen voting",
    error: "Unable to reopen voting: {error}",
    confirm: "Reopen voting? Existing ballots will be retained, scheduled publication will be cancelled, and the voting deadline must still be in the future.",
  },
  results_published: {
    target: "review_pending",
    action: "Return to review",
    error: "Unable to return competition to review: {error}",
    confirm: "Return to review? Published results will no longer be visible and their snapshots will be removed.",
  },
};
