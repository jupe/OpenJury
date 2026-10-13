"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthBoundary";
import Button from "@/components/Button";
import { useLocale } from "@/lib/i18n";

type ReminderStatus = { phase: string | null; recipient_count: number; next_allowed_at: string | null };

const descriptions: Record<string, string> = {
  submission: "Remind group members who have not joined, or participants who have not submitted an entry.",
  voting: "Remind eligible voters who have not scored every available entry in every category.",
  results_published: "Notify group members that the published results are available.",
};

export default function CompetitionReminders({
  competitionId, phase, busy, onPending,
}: { competitionId: string; phase: string; busy: boolean; onPending: (pending: boolean) => void }) {
  const { client, session } = useAuth();
  const { t, formatDateTime } = useLocale();
  const [status, setStatus] = useState<ReminderStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const demo = session.access_token.startsWith("demo-");

  useEffect(() => {
    if (demo || !descriptions[phase]) return;
    let active = true;
    async function load() {
      try {
        const result = await client.rpc("get_competition_reminder_status", { p_competition_id: competitionId });
        if (active) setStatus(result.error ? null : result.data?.[0] ?? null);
      } catch {
        if (active) setStatus(null);
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [client, competitionId, phase, demo, attempt]);

  if (!descriptions[phase]) return null;
  const limited = !!status?.next_allowed_at && new Date(status.next_allowed_at).getTime() > Date.now();
  const disabled = demo || busy || sending || !status?.phase || !status.recipient_count || limited;

  async function send() {
    if (disabled || !window.confirm(t("Send a web push reminder to {count} member(s)?", { count: status!.recipient_count }))) return;
    setSending(true);
    setError("");
    setMessage("");
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError || !data.session) throw new Error("Authentication required");
      const response = await fetch(`/api/competitions/${encodeURIComponent(competitionId)}/remind`, {
        method: "POST",
        headers: { Authorization: ["Bearer", data.session.access_token].join(" ") },
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (!response.ok || result.queued !== true) {
        setError(response.status === 429
          ? "Reminder limit reached. Please wait before sending another reminder."
          : response.status === 503 ? "Web push is not configured"
            : response.status === 409 ? "No eligible recipients or reminders are unavailable in this phase."
              : "Unable to queue competition reminders");
        return;
      }
      setStatus({ phase: result.phase, recipient_count: result.recipient_count, next_allowed_at: result.next_allowed_at });
      setMessage(result.notificationsSent === true ? "Reminder notifications sent." : "Reminders queued. Some push notifications are pending. Retry delivery.");
      onPending(result.notificationsSent !== true);
    } catch {
      setError("Unable to confirm reminder delivery. Refresh before trying again; queued reminders still count toward the limit.");
      onPending(true);
    } finally {
      setSending(false);
      setAttempt((value) => value + 1);
    }
  }

  return (
    <section className="mt-4 space-y-3 border-t border-slate-100 pt-4" aria-label={t("Competition reminders")}>
      <h3 className="font-semibold">{t("Competition reminders")}</h3>
      <p className="text-sm">{t(descriptions[phase])}</p>
      <p className="text-sm text-slate-600">{t("Web push only, to members who enabled notifications. No emails are sent.")}</p>
      <p className="text-sm text-slate-600">{t("At most one reminder per hour and three per 24 hours per competition; 15 minutes between reminders in this group.")}</p>
      {demo ? <p>{t("Reminders are unavailable in the demo.")}</p>
        : !status ? <p role="status">{t("Reminder availability could not be loaded. Refresh to try again.")}</p>
          : !status.phase ? <p>{t("Reminders are unavailable after the deadline.")}</p>
            : <p>{t("{count} member(s) can receive this reminder.", { count: status.recipient_count })}</p>}
      {limited && <p role="status">{t("Next reminder available {date}.", { date: formatDateTime(status!.next_allowed_at!) })}</p>}
      <Button variant="secondary" disabled={disabled} onClick={() => void send()}>
        {t(sending ? "Sending…" : "Notify members")}
      </Button>
      {message && <p role="status">{t(message)}</p>}
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}
