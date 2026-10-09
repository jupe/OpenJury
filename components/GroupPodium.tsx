"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Card from "@/components/Card";
import { useLocale } from "@/lib/i18n";

type Result = { rank: number; score: number | null; creator_id: string; creator_name: string; is_disqualified: boolean };
type Winner = { id: string; name: string; gold: number; silver: number; bronze: number; points: number };

const PLACES = [
  { key: "gold", label: "1st place", medal: "bg-amber-400 text-amber-950", height: "h-28", weight: 3 },
  { key: "silver", label: "2nd place", medal: "bg-slate-300 text-slate-900", height: "h-20", weight: 2 },
  { key: "bronze", label: "3rd place", medal: "bg-orange-400 text-orange-950", height: "h-14", weight: 1 },
] as const;

/** Ranks group members by podium finishes (top 3) across the group's published competitions. */
export function topWinners(results: Result[][]): Winner[] {
  const winners = new Map<string, Winner>();
  for (const competition of results) {
    for (const result of competition) {
      if (result.is_disqualified || result.rank < 1 || result.rank > 3) continue;
      const winner = winners.get(result.creator_id) ?? { id: result.creator_id, name: result.creator_name, gold: 0, silver: 0, bronze: 0, points: 0 };
      winner[PLACES[result.rank - 1].key] += 1;
      winner.points += PLACES[result.rank - 1].weight;
      winners.set(result.creator_id, winner);
    }
  }
  return [...winners.values()]
    .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.name.localeCompare(b.name))
    .slice(0, 3);
}

export default function GroupPodium({ groupId }: { groupId: string }) {
  const { client } = useAuth();
  const { t } = useLocale();
  const [winners, setWinners] = useState<Winner[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const competitions = await client.from("competitions").select("id").eq("group_id", groupId).eq("status", "results_published");
      if (competitions.error || !competitions.data?.length) return void (active && setWinners([]));
      const all = await Promise.all(competitions.data.map(async ({ id }) => {
        const { data, error } = await client.rpc("get_published_competition_results", { p_competition_id: id });
        return error ? [] : (data || []) as Result[];
      }));
      if (active) setWinners(topWinners(all));
    })().catch(() => undefined);
    return () => { active = false; };
  }, [client, groupId]);

  if (!winners?.length) return null;
  // Podium order: 2nd, 1st, 3rd.
  const slots = [1, 0, 2].filter((index) => winners[index]);
  return (
    <Card title={t("Top 3 winners")}>
      <ol aria-label={t("Top 3 winners")} className="flex items-end justify-center gap-3 pt-2">
        {slots.map((index) => {
          const winner = winners[index];
          const place = PLACES[index];
          return (
            <li key={winner.id} className="flex w-full max-w-36 flex-col items-center gap-1 text-center">
              <span aria-hidden className={`inline-flex size-10 items-center justify-center rounded-full text-lg font-bold shadow ${place.medal}`}>{index + 1}</span>
              <span className="w-full break-words text-sm font-semibold text-slate-900">{winner.name}</span>
              <span className="text-xs text-slate-500">
                {t("{count} wins", { count: winner.gold })} · {t("{count} podiums", { count: winner.gold + winner.silver + winner.bronze })}
              </span>
              <div className={`flex w-full items-start justify-center rounded-t-lg pt-2 text-xs font-semibold ${place.medal} ${place.height}`}>{t(place.label)}</div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
