import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function configuration() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.COMPETITION_EMAIL_FROM;
  const appUrl = process.env.APP_URL;
  if (!url || !anonKey || !resendKey || !from || !appUrl) return null;
  if ([anonKey, resendKey].some((key) => /\s/.test(key))) return null;
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(from)) return null;
  try {
    const origin = new URL(appUrl);
    const backend = new URL(url);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return null;
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) return null;
    if (!["https:", "http:"].includes(backend.protocol) || backend.username || backend.password
      || backend.search || backend.hash) return null;
    return { url, anonKey, resendKey, from, origin: origin.origin };
  } catch {
    return null;
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
  const config = configuration();
  if (!config) return json({ error: "Invitation emails are not configured" }, 503);
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
    if (authError || !user.user) return json({ error: "Authentication required" }, 401);
    // The user-scoped RPC, not the email provider, authorizes the invitation.
    const { error } = await client.rpc("invite_group_member_by_email", {
      p_group_id: groupId, p_email: email,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 502;
      return json({ error: status === 403 ? "Group administrator access required"
        : status === 400 ? "Enter a valid email address" : "Unable to invite member" }, status);
    }
    invited = true;
    const { data: group, error: groupError } = await client.from("groups").select("name").eq("id", groupId).single();
    if (groupError || !group) throw new Error("Group unavailable");
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
    if (!response.ok) throw new Error("Email provider rejected invitation");
    return json({ invited: true, emailSent: true });
  } catch {
    return json({ invited, error: invited
      ? "Invitation saved, but email delivery failed. Please retry."
      : "Unable to invite member" }, 502);
  }
}
