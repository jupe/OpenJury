"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Card from "@/components/Card";
import Podium from "@/components/Podium";
import { useLocale } from "@/lib/i18n";

type Result = { rank: number; score: number | null; creator_id: string; creator_name: string; is_disqualified: boolean };
type Winner = { id: string; name: string; gold: number; silver: number; bronze: number; points: number };

const PLACES = [
  { key: "gold", weight: 3 },
  { key: "silver", weight: 2 },
  { key: "bronze", weight: 1 },
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
  return (
    <Card title={t("Top 3 winners")}>
      <Podium label={t("Top 3 winners")} spots={winners.map((winner, index) => ({
        key: winner.id,
        place: (index + 1) as 1 | 2 | 3,
        name: winner.name,
        detail: `${t("{count} wins", { count: winner.gold })} · ${t("{count} podiums", { count: winner.gold + winner.silver + winner.bronze })}`,
      }))} />
    </Card>
  );
}
