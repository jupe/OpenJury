import { backendConfiguration, bearer, drainCompetitionPush, json, pushClient, uuidPattern, vapidConfiguration } from "@/lib/web-push";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ competitionId: string }> }) {
  const deadline = Date.now() + 25_000;
  const token = bearer(request);
  if (!token) return json({ error: "Authentication required" }, 401);
  const { competitionId } = await params;
  if (!uuidPattern.test(competitionId)) return json({ error: "Invalid competition ID" }, 400);
  const config = backendConfiguration(true);
  const vapidDetails = vapidConfiguration();
  if (!config?.serviceKey || !vapidDetails) return json({ error: "Web push is not configured" }, 503);
  let queued: { phase: string; recipient_count: number; next_allowed_at: string } | undefined;
  try {
    const client = pushClient(config.url, config.anonKey, token, deadline);
    const { data, error: authError } = await client.auth.getUser(token);
    if (authError || !data.user) return json({ error: "Authentication required" }, 401);
    const result = await client.rpc("queue_competition_reminder", { p_competition_id: competitionId });
    if (result.error) {
      const errors: Record<string, [number, string]> = {
        "42501": [403, "Competition administrator access required"],
        "54000": [429, "Reminder limit reached. Please wait before sending another reminder."],
        "22023": [409, "No eligible recipients or reminders are unavailable in this phase."],
      };
      const [status, error] = errors[result.error.code] ?? [502, "Unable to queue competition reminders"];
      return json({ error }, status);
    }
    queued = result.data?.[0];
    if (!queued) return json({ error: "Unable to queue competition reminders" }, 502);
    const service = pushClient(config.url, config.serviceKey, undefined, deadline);
    return json({ ...queued, queued: true,
      notificationsSent: await drainCompetitionPush(service, competitionId, vapidDetails, { deadline, remaining: 50 }) });
  } catch {
    return queued ? json({ ...queued, queued: true, notificationsSent: false })
      : json({ error: "Unable to queue competition reminders" }, 502);
  }
}
