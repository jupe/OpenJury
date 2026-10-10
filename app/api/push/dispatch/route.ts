import { createHash, timingSafeEqual } from "node:crypto";
import { backendConfiguration, bearer, drainCompetitionPush, json, pushClient, uuidPattern, vapidConfiguration } from "@/lib/web-push";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.WEB_PUSH_DISPATCH_SECRET;
  if (!secret || secret.length < 32 || /\s/.test(secret)) return json({ error: "Dispatcher is not configured" }, 503);
  const token = bearer(request);
  if (!token || !timingSafeEqual(createHash("sha256").update(token).digest(),
    createHash("sha256").update(secret).digest())) return json({ error: "Authentication required" }, 401);
  const config = backendConfiguration(true);
  const vapidDetails = vapidConfiguration();
  if (!config?.serviceKey || !vapidDetails) return json({ error: "Web push is not configured" }, 503);
  const budget = { deadline: Date.now() + 25_000, remaining: 50 };
  try {
    const service = pushClient(config.url, config.serviceKey, undefined, budget.deadline);
    // The lifecycle RPCs already lock eligible competitions and are service-only.
    for (const rpc of ["process_remote_competition_deadlines", "process_scheduled_competition_publications"]) {
      const result = await service.rpc(rpc);
      if (result.error) return json({ notificationsSent: false });
    }
    const pending = await service.rpc("pending_competition_push_dispatch");
    if (pending.error) return json({ notificationsSent: false });
    let complete = true;
    for (const row of (pending.data || []) as { competition_id: string }[]) {
      if (budget.remaining <= 0 || budget.deadline - Date.now() <= 6_000) { complete = false; break; }
      if (!uuidPattern.test(row.competition_id)) return json({ notificationsSent: false });
      // A failed/backed-off competition does not starve other groups.
      const sent = await drainCompetitionPush(service, row.competition_id, vapidDetails, budget);
      complete = sent && complete;
    }
    const remaining = await service.rpc("all_competition_push_sent");
    return json({ notificationsSent: complete && !remaining.error && remaining.data === true });
  } catch {
    return json({ notificationsSent: false });
  }
}
