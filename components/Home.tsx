"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Card from "@/components/Card";
import { StatusBadge } from "@/components/CompetitionStatus";
import { Icon, type IconName } from "@/components/IconButton";
import { useRealtimeUpdates } from "@/lib/useRealtimeUpdates";
import { useLocale } from "@/lib/i18n";

type Overview = {
  group_count: number;
  active_competition_count: number;
  entry_count: number;
  voted_entry_count: number;
  win_count: number;
  podium_count: number;
};

type Action = "join" | "submit" | "vote";

const actionLabels: Record<Action, string> = {
  join: "Choose your role",
  submit: "Submit your entry",
  vote: "Vote now",
};

type ActiveCompetition = {
  id: string;
  name: string;
  status: "submission" | "voting";
  submission_deadline: string | null;
  voting_deadline: string | null;
  groups: { name: string } | { name: string }[] | null;
  competition_participants: { role: "participant" | "audience" }[] | null;
};

function StatTile({ icon, label, value, detail }: { icon: IconName; label: string; value: number; detail?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <Icon name={icon} className="size-4" />
        </span>
        {label}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{value.toLocaleString()}</p>
      {detail && <p className="mt-1 text-sm text-slate-500">{detail}</p>}
    </div>
  );
}

/** The signed-in home page: personal totals and the competitions open right now. */
export function HomeOverview() {
  const { t, formatDateTime } = useLocale();
  const { client, session } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [active, setActive] = useState<ActiveCompetition[] | null>(null);
  const [actions, setActions] = useState<Map<string, Action>>(new Map());
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const displayName = typeof session.user.user_metadata.display_name === "string"
    ? session.user.user_metadata.display_name.trim() : "";

  useRealtimeUpdates(client, session.user.id, null, () => setAttempt((value) => value + 1));

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        // Optional: without the migration the page still lists open competitions.
        const optional = (name: string) =>
          client.rpc(name).abortSignal(controller.signal).then((result) => result, () => ({ data: null, error: null }));
        const [stats, todo, competitions] = await Promise.all([
          optional("get_my_overview"),
          optional("get_my_competition_actions"),
          client.from("competitions")
            .select("id,name,status,submission_deadline,voting_deadline,groups(name),competition_participants(role)")
            .in("status", ["submission", "voting"])
            .abortSignal(controller.signal),
        ]);
        if (!current) return;
        const row = Array.isArray(stats.data) ? stats.data[0] : null;
        setOverview(stats.error || !row ? null : row as Overview);
        setActions(new Map(!todo.error && Array.isArray(todo.data)
          ? (todo.data as { competition_id: string; action: Action }[]).map((item) => [item.competition_id, item.action])
          : []));
        if (competitions.error) setError(t("Unable to load competitions: {error}", { error: t(competitions.error.message) }));
        else {
          setError("");
          const deadline = (competition: ActiveCompetition) =>
            Date.parse((competition.status === "submission" ? competition.submission_deadline : competition.voting_deadline) ?? "") || Number.MAX_SAFE_INTEGER;
          setActive([...(competitions.data as ActiveCompetition[])].sort((a, b) => deadline(a) - deadline(b)));
        }
      } catch {
        if (current) setError(t("Unable to load competitions. Please try again."));
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [client, attempt, t]);

  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">
        {displayName ? t("Welcome back, {name}", { name: displayName }) : t("Welcome back")}
      </h1>

      {overview && (() => {
        // Wins appear once there is a placement to show, rather than a row of zeros.
        const placed = overview.win_count > 0 || overview.podium_count > 0;
        return (
          <section aria-label={t("Your activity")} className={`grid grid-cols-2 gap-3 ${placed ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
            <div className={placed ? "" : "col-span-2 lg:col-span-1"}>
              <StatTile icon="trophy" label={t("Active competitions")} value={overview.active_competition_count}
                detail={t("Open for entries or voting")} />
            </div>
            <StatTile icon="member" label={t("Groups")} value={overview.group_count} />
            {placed && (
              <StatTile icon="audience" label={t("Wins")} value={overview.win_count}
                detail={t(overview.podium_count === 1 ? "{count} podium finish" : "{count} podium finishes", { count: overview.podium_count })} />
            )}
            <StatTile icon="participant" label={t("Entries")} value={overview.entry_count}
              detail={t(overview.voted_entry_count === 1 ? "Voted on {count} entry" : "Voted on {count} entries", { count: overview.voted_entry_count })} />
          </section>
        );
      })()}

      <Card title={t("Happening now")} action={<Link href="/dashboard" className="text-sm font-semibold text-indigo-700 hover:underline">{t("All groups")}</Link>}>
        {error ? <p role="alert">{error}</p> : active === null ? <p role="status">{t("Loading competitions…")}</p> : active.length ? (
          <ul className="space-y-2">
            {/* Competitions waiting on the user come first, each still by deadline. */}
            {[...active].sort((a, b) => Number(actions.has(b.id)) - Number(actions.has(a.id))).map((competition) => {
              const action = actions.get(competition.id);
              const group = [competition.groups].flat()[0]?.name;
              const role = competition.competition_participants?.[0]?.role;
              const deadline = competition.status === "submission" ? competition.submission_deadline : competition.voting_deadline;
              return (
                <li key={competition.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border p-3 ${action ? "border-indigo-200 bg-indigo-50" : "border-slate-100"}`}>
                  <div className="min-w-0 flex-1">
                    <Link href={`/competition/${encodeURIComponent(competition.id)}`} className="font-semibold break-words text-slate-900 underline">
                      {competition.name}
                    </Link>
                    <p className="text-sm text-slate-500">
                      {group}
                      {deadline && ` · ${t(competition.status === "submission" ? "Submissions close {date}" : "Voting closes {date}", { date: formatDateTime(deadline) })}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {role && <span className="text-slate-500">{t(role === "participant" ? "Participant" : "Audience")}</span>}
                    <StatusBadge status={competition.status} />
                    {action && (
                      <Link
                        href={`/competition/${encodeURIComponent(competition.id)}`}
                        aria-label={`${t(actionLabels[action])}: ${competition.name}`}
                        className="inline-flex min-h-11 items-center rounded-xl bg-indigo-600 px-3 font-semibold text-white hover:bg-indigo-700"
                      >
                        {t(actionLabels[action])}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>{t("No competitions are open right now.")}</p>
        )}
      </Card>
    </>
  );
}
