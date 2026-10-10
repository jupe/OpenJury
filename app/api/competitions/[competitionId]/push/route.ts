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
  let authorized = false;
  try {
    const client = pushClient(config.url, config.anonKey, token, deadline);
    const { data, error: authError } = await client.auth.getUser(token);
    if (authError || !data.user) return json({ error: "Authentication required" }, 401);
    const permission = await client.rpc("authorize_competition_push", { p_competition_id: competitionId });
    if (permission.error) return json({ error: "Competition administrator access required" },
      permission.error.code === "42501" ? 403 : 502);
    authorized = true;
    // No service-role client or reads exist until the authenticated RPC authorizes this group.
    const service = pushClient(config.url, config.serviceKey, undefined, deadline);
    return json({ notificationsSent: await drainCompetitionPush(service, competitionId, vapidDetails, { deadline, remaining: 50 }) });
  } catch {
    return authorized ? json({ notificationsSent: false }) : json({ error: "Unable to authorize web push" }, 502);
  }
}
