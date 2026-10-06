"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Card from "@/components/Card";

// Competitions members can currently take part in.
const ACTIVE_STATUSES = new Set(["submission", "voting"]);

/** Sends the member to the competitions of their first group (dashboard order) with an active competition. */
export default function ActiveCompetitionRedirect() {
  const { client } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "none" | "error">("loading");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [groups, competitions] = await Promise.all([
          client.from("groups").select("id,name").order("name"),
          client.from("competitions").select("group_id,status"),
        ]);
        if (!active) return;
        if (groups.error || competitions.error) {
          setState("error");
          return;
        }
        const withActive = new Set((competitions.data as { group_id: string; status: string }[])
          .filter((competition) => ACTIVE_STATUSES.has(competition.status))
          .map((competition) => competition.group_id));
        const group = (groups.data as { id: string }[]).find(({ id }) => withActive.has(id));
        if (group) router.replace(`/group/${encodeURIComponent(group.id)}#competitions`);
        else setState("none");
      } catch {
        if (active) setState("error");
      }
    })();
    return () => { active = false; };
  }, [client, router]);

  if (state === "loading") return <p role="status">Finding active competitions…</p>;
  return (
    <Card title={state === "none" ? "No active competitions" : "Competitions unavailable"}>
      {state === "none"
        ? <p>None of your groups has a competition open for entries or voting right now.</p>
        : <p role="alert">Unable to load your competitions. Please try again.</p>}
      <Link href="/dashboard" className="underline">Go to your groups</Link>
    </Card>
  );
}
