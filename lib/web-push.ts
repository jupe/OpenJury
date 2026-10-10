import { createECDH, ECDH } from "node:crypto";
import webPush from "web-push";
import { createClient } from "@supabase/supabase-js";

export const pushSender = webPush;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function bearer(request: Request) {
  const parts = (request.headers.get("authorization") || "").split(/\s+/);
  return parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] ? parts[1] : undefined;
}

function base64url(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value;
}

export function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && !url.hash && !value.includes("#") && url.href === value
      && (url.hostname === "web.push.apple.com" || url.hostname.endsWith(".push.apple.com"))
      && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export function validSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as PushSubscription;
  if (!validEndpoint(subscription.endpoint) || !subscription.keys
    || !base64url(subscription.keys.p256dh, 65) || !base64url(subscription.keys.auth, 16)) return false;
  try {
    const bytes = Buffer.from(subscription.keys.p256dh, "base64url");
    if (bytes[0] !== 4) return false;
    ECDH.convertKey(bytes, "prime256v1", undefined, undefined, "uncompressed");
    return true;
  } catch {
    return false;
  }
}

export function publicKey() {
  const key = process.env.WEB_PUSH_PUBLIC_KEY;
  return key && validSubscription({
    endpoint: "https://web.push.apple.com/check",
    keys: { p256dh: key, auth: Buffer.alloc(16).toString("base64url") },
  }) ? key : null;
}

export function vapidConfiguration() {
  const publicValue = publicKey();
  const privateValue = process.env.WEB_PUSH_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT;
  if (!publicValue || !base64url(privateValue, 32) || !subject) return null;
  try {
    const contact = new URL(subject);
    if (contact.username || contact.password || contact.hash
      || !["mailto:", "https:"].includes(contact.protocol)
      || (contact.protocol === "mailto:" && !/^[^@\s]+@[^@\s]+$/.test(contact.pathname))) return null;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateValue, "base64url"));
    if (ecdh.getPublicKey().toString("base64url") !== publicValue) return null;
    return { subject, publicKey: publicValue, privateKey: privateValue };
  } catch {
    return null;
  }
}

export function backendConfiguration(service = false) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || /\s/.test(anonKey) || (service && (!serviceKey || /\s/.test(serviceKey)))) return null;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash) return null;
    return { url, anonKey, serviceKey };
  } catch {
    return null;
  }
}

export function pushClient(url: string, key: string, token?: string, deadline = Date.now() + 25_000) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      ...(token ? { headers: { Authorization: ["Bearer", token].join(" ") } } : {}),
      fetch: (input, init) => fetch(input, {
        ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))),
      }),
    },
  });
}

export async function boundedBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error("Body too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

export function notification(competitionId: string, eventId: string, phase: string, locale: string) {
  const messages: Record<string, { en: string; fi: string }> = {
    submission: { en: "Submissions are now open.", fi: "Osallistuminen on nyt avoinna." },
    voting: { en: "Voting is now open.", fi: "Äänestys on nyt avoinna." },
    results_published: { en: "Competition results are now available.", fi: "Kilpailun tulokset ovat nyt saatavilla." },
  };
  if (!uuidPattern.test(competitionId) || !uuidPattern.test(eventId) || !messages[phase]) throw new Error("Invalid notification");
  return {
    title: "OpenJury", body: messages[phase][locale === "fi" ? "fi" : "en"],
    url: `/competition/${competitionId}`, tag: `openjury-${competitionId}-${eventId}`,
  };
}

export async function drainCompetitionPush(
  service: ReturnType<typeof pushClient>,
  competitionId: string,
  vapidDetails: NonNullable<ReturnType<typeof vapidConfiguration>>,
  budget: { deadline: number; remaining: number },
) {
  while (budget.remaining > 0 && budget.deadline - Date.now() > 6_000) {
    budget.remaining--;
    const claim = await service.rpc("claim_competition_push", { p_competition_id: competitionId });
    if (claim.error) return false;
    const row = claim.data?.[0] as {
      id: string; claim_token: string; event_id: string; phase: string;
      locale: string; subscription: PushSubscription;
    } | undefined;
    if (!row) break;
    if (!validSubscription(row.subscription)) {
      const invalid = await service.rpc("finish_competition_push", {
        p_id: row.id, p_claim_token: row.claim_token, p_outcome: "expired",
      });
      if (invalid.error || invalid.data !== true) return false;
      continue;
    }
    const active = await service.rpc("competition_push_claim_active", { p_id: row.id, p_claim_token: row.claim_token });
    if (active.error) return false;
    let outcome = active.data === true ? "retry" : "skipped";
    if (active.data === true) {
      try {
        await pushSender.sendNotification(row.subscription,
          JSON.stringify(notification(competitionId, row.event_id, row.phase, row.locale)), {
            vapidDetails, TTL: 3600, urgency: "normal", timeout: Math.min(5_000, budget.deadline - Date.now() - 1_000),
          });
        outcome = "sent";
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) outcome = "expired";
      }
    }
    const ack = await service.rpc("finish_competition_push", {
      p_id: row.id, p_claim_token: row.claim_token, p_outcome: outcome,
    });
    if (ack.error || ack.data !== true || outcome === "retry") return false;
  }
  const complete = await service.rpc("competition_push_sent", { p_competition_id: competitionId });
  return !complete.error && complete.data === true;
}
