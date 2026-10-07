import { createClient } from "@supabase/supabase-js";
import { mailConfiguration, mailer, sendMail, type MailConfig, type MailMessage, type MailTransport } from "@/lib/mailer";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function configuration(): {
  url: string; anonKey: string; serviceKey: string; mail: MailConfig; origin: string;
} | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appUrl = process.env.APP_URL;
  const mail = mailConfiguration();
  if (!url || !anonKey || !serviceKey || !appUrl || "error" in mail) return null;
  if ([anonKey, serviceKey].some((key) => /\s/.test(key))) return null;
  try {
    const origin = new URL(appUrl);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return null;
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) return null;
    const backend = new URL(url);
    if (!["https:", "http:"].includes(backend.protocol) || backend.username || backend.password
      || backend.search || backend.hash) return null;
    return { url, anonKey, serviceKey, mail, origin: origin.origin };
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ competitionId: string }> },
) {
  const deadline = Date.now() + 25_000;
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
  const timeout = () => AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: timeout() });
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  };
  let started = false;
  let transport: MailTransport | null = null;
  try {
    const userClient = createClient(config.url, config.anonKey, {
      ...options, global: { ...options.global, headers: { Authorization: ["Bearer", token].join(" ") } },
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
    let nextSendAt = 0;
    // Bound time and count; subsequent explicit retries drain the original snapshot.
    for (let count = 0; count < 50; count++) {
      const wait = Math.max(0, nextSendAt - Date.now());
      if (deadline - Date.now() < wait + 2_000) break;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const claim = await service.rpc("claim_competition_start_email", {
        p_competition_id: competitionId, p_from: config.mail.from, p_origin: config.origin,
      });
      if (claim.error) return json({ started: true, notificationsSent: false });
      const email = claim.data?.[0] as { id: string; claim_token: string; payload: MailMessage } | undefined;
      if (!email) break;
      let sent = false;
      try {
        // Pace messages so a large group stays within SMTP providers' sending limits.
        nextSendAt = Date.now() + 600;
        transport ??= mailer.createTransport(config.mail);
        await sendMail(transport, config.mail, email.payload);
        sent = true;
      } catch {
        // A lost reply after the server accepted the message is ambiguous; SMTP has no
        // idempotency key, so a retry of this frozen payload may deliver it twice.
      }
      if (Date.now() >= deadline) return json({ started: true, notificationsSent: false });
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
  } finally {
    transport?.close();
  }
}
