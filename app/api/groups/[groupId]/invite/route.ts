import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// One JSON line per event, read with `docker compose logs web`. Never log secrets,
// tokens, full addresses, or payloads; the recipient is identified by domain only.
function log(event: string, details: Record<string, unknown> = {}, level: "info" | "error" = "info") {
  console[level](JSON.stringify({ scope: "group-invite", event, ...details }));
}

function configuration(): { error: string } | {
  url: string; anonKey: string; resendKey: string; from: string; origin: string;
} {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.COMPETITION_EMAIL_FROM;
  const appUrl = process.env.APP_URL;
  const missing = Object.entries({
    SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, RESEND_API_KEY: resendKey,
    COMPETITION_EMAIL_FROM: from, APP_URL: appUrl,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length || !url || !anonKey || !resendKey || !from || !appUrl) {
    return { error: `missing ${missing.join(", ")}` };
  }
  if ([anonKey, resendKey].some((key) => /\s/.test(key))) return { error: "key contains whitespace" };
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(from)) {
    return { error: "COMPETITION_EMAIL_FROM is not a bare address" };
  }
  try {
    const origin = new URL(appUrl);
    const backend = new URL(url);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      return { error: "APP_URL must be an origin without path, query, or credentials" };
    }
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) {
      return { error: "APP_URL must use HTTPS" };
    }
    if (!["https:", "http:"].includes(backend.protocol) || backend.username || backend.password
      || backend.search || backend.hash) return { error: "SUPABASE_URL is invalid" };
    return { url, anonKey, resendKey, from, origin: origin.origin };
  } catch {
    return { error: "APP_URL or SUPABASE_URL is not a URL" };
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  const authorization = (request.headers.get("authorization") || "").split(/\s+/);
  const token = authorization.length === 2 && authorization[0].toLowerCase() === "bearer"
    ? authorization[1] : null;
  if (!token) return json({ error: "Authentication required" }, 401);
  const { groupId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId)) {
    return json({ error: "Invalid group ID" }, 400);
  }
  let email: string;
  try {
    const body = await request.json();
    email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 320 || !/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(email)) {
      return json({ error: "Enter a valid email address" }, 400);
    }
  } catch {
    return json({ error: "Enter a valid email address" }, 400);
  }
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const context = { requestId, groupId, recipientDomain: email.split("@")[1] };
  const config = configuration();
  if ("error" in config) {
    log("not-configured", { ...context, reason: config.error }, "error");
    return json({ error: "Invitation emails are not configured" }, 503);
  }
  let invited = false;
  try {
    const client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { Authorization: ["Bearer", token].join(" ") },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
      },
    });
    const { data: user, error: authError } = await client.auth.getUser(token);
    if (authError || !user.user) {
      log("auth-failed", { ...context, error: authError?.message }, "error");
      return json({ error: "Authentication required" }, 401);
    }
    // The user-scoped RPC, not the email provider, authorizes the invitation.
    const { error } = await client.rpc("invite_group_member_by_email", {
      p_group_id: groupId, p_email: email,
    });
    if (error) {
      log("invite-rejected", { ...context, code: error.code, error: error.message }, "error");
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 502;
      return json({ error: status === 403 ? "Group administrator access required"
        : status === 400 ? "Enter a valid email address" : "Unable to invite member" }, status);
    }
    invited = true;
    log("invite-saved", context);
    const { data: group, error: groupError } = await client.from("groups").select("name").eq("id", groupId).single();
    if (groupError || !group) throw new Error(`Group unavailable: ${groupError?.message ?? "not found"}`);
    const sendStarted = Date.now();
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: ["Bearer", config.resendKey].join(" "),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [email],
        subject: "You have been invited to an OpenJury group",
        text: `You have been invited to "${group.name}" on OpenJury.\nSign in with ${email} to join the group:\n${config.origin}/dashboard`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // Resend's body names the problem (unverified domain, bad key, rate limit) or the message ID.
    const body = (await response.text().catch(() => "")).replaceAll(email, "<recipient>").slice(0, 500);
    if (!response.ok) {
      log("resend-rejected", { ...context, status: response.status, body, sendMs: Date.now() - sendStarted }, "error");
      return json({ invited, error: "Invitation saved, but email delivery failed. Please retry." }, 502);
    }
    let resendId: unknown;
    try { resendId = JSON.parse(body).id; } catch { resendId = undefined; }
    log("email-accepted", { ...context, resendId, sendMs: Date.now() - sendStarted, totalMs: Date.now() - started });
    return json({ invited: true, emailSent: true });
  } catch (error) {
    // Timeouts and network failures reaching Supabase or Resend land here.
    log("unexpected-error", { ...context, invited, error: String(error), totalMs: Date.now() - started }, "error");
    return json({ invited, error: invited
      ? "Invitation saved, but email delivery failed. Please retry."
      : "Unable to invite member" }, 502);
  }
}
