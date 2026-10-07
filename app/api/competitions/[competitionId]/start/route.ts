import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function configuration() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.COMPETITION_EMAIL_FROM;
  const appUrl = process.env.APP_URL;
  if (!url || !anonKey || !serviceKey || !resendKey || !from || !appUrl) return null;
  if ([anonKey, serviceKey, resendKey].some((key) => /\s/.test(key))) return null;
  if (/[\r\n]/.test(from) || !/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(from)) return null;
  try {
    const origin = new URL(appUrl);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return null;
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) return null;
    const backend = new URL(url);
    if (!["https:", "http:"].includes(backend.protocol) || backend.username || backend.password
      || backend.search || backend.hash) return null;
    return { url, anonKey, serviceKey, resendKey, from, origin: origin.origin };
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ competitionId: string }> },
) {
  const authorization = (request.headers.get("authorization") || "").split(/\s+/);
  const token = authorization.length === 2 && authorization[0].toLowerCase() === "bearer"
    ? authorization[1] : null;
  if (!token) return json({ error: "Authentication required" }, 401);
  const { competitionId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(competitionId)) {
    return json({ error: "Invalid competition ID" }, 400);
  }
  const config = configuration();
  if (!config) return json({ error: "Competition email notifications are not configured" }, 503);
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  let started = false;
  try {
    const userClient = createClient(config.url, config.anonKey, {
      ...options, global: { headers: { Authorization: ["Bearer", token].join(" ") } },
    });
    const service = createClient(config.url, config.serviceKey, options);
    const { data: user, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user.user) return json({ error: "Authentication required" }, 401);
    const { error } = await userClient.rpc("start_competition", {
      p_competition_id: competitionId, p_notify: true,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "55000" ? 409 : 502;
      return json({ error: status === 403 ? "Competition administrator access required"
        : status === 409 ? "Competition cannot be started or retried" : "Unable to start competition" }, status);
    }
    started = true;
    // Bound each request; subsequent explicit retries drain the original snapshot.
    for (let count = 0; count < 50; count++) {
      const claim = await service.rpc("claim_competition_start_email", {
        p_competition_id: competitionId, p_from: config.from, p_origin: config.origin,
      });
      if (claim.error) return json({ started: true, notificationsSent: false });
      const email = claim.data?.[0] as { id: string; claim_token: string; payload: object } | undefined;
      if (!email) break;
      let sent = false;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: ["Bearer", config.resendKey].join(" "),
            "Content-Type": "application/json",
            "Idempotency-Key": `competition-start-${email.id}`,
          },
          body: JSON.stringify(email.payload),
          signal: AbortSignal.timeout(10_000),
        });
        sent = response.ok;
      } catch {
        // Network timeouts can be ambiguous; retries use the same frozen payload/key.
      }
      const finish = await service.rpc("finish_competition_start_email", {
        p_id: email.id, p_claim_token: email.claim_token, p_sent: sent,
      });
      if (!sent || finish.error) return json({ started: true, notificationsSent: false });
    }
    const complete = await service.rpc("competition_start_emails_sent", { p_competition_id: competitionId });
    return json({ started: true, notificationsSent: !complete.error && complete.data === true });
  } catch {
    return started
      ? json({ started: true, notificationsSent: false })
      : json({ error: "Unable to start competition" }, 502);
  }
}
