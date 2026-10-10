import { backendConfiguration, bearer, boundedBody, json, pushClient, validEndpoint, validSubscription, vapidConfiguration } from "@/lib/web-push";

export const runtime = "nodejs";

export function GET() {
  const config = vapidConfiguration();
  return config ? json({ publicKey: config.publicKey }) : json({ error: "Web push is not configured" }, 503);
}

async function mutate(request: Request, remove: boolean) {
  const token = bearer(request);
  if (!token) return json({ error: "Authentication required" }, 401);
  const config = backendConfiguration();
  if (!config) return json({ error: "Web push is not configured" }, 503);
  let body: { subscription?: unknown; locale?: unknown; endpoint?: unknown };
  try {
    const parsed = await boundedBody(request);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid body");
    body = parsed;
    if (remove) {
      if (validEndpoint(body.endpoint)) body.subscription = { endpoint: body.endpoint };
      if (!body.subscription || typeof body.subscription !== "object"
        || !validEndpoint((body.subscription as { endpoint?: unknown }).endpoint)) throw new Error("Invalid endpoint");
    } else if (!validSubscription(body.subscription) || (body.locale !== "en" && body.locale !== "fi")) {
      throw new Error("Invalid subscription");
    }
  } catch {
    return json({ error: "Invalid subscription" }, 400);
  }
  try {
    const client = pushClient(config.url, config.anonKey, token);
    const { data, error: authError } = await client.auth.getUser(token);
    if (authError || !data.user) return json({ error: "Authentication required" }, 401);
    const subscription = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } };
    const { error } = await client.rpc(remove ? "delete_my_push_subscription" : "save_my_push_subscription",
      remove ? { p_endpoint: subscription.endpoint } : {
        p_endpoint: subscription.endpoint, p_p256dh: subscription.keys.p256dh,
        p_auth: subscription.keys.auth, p_locale: body.locale,
      });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "54000" ? 429
        : error.code === "23505" ? 409 : error.code === "22023" ? 400 : 502;
      return json({ error: "Unable to update push subscription" }, status);
    }
    return json({ subscribed: !remove });
  } catch {
    return json({ error: "Unable to update push subscription" }, 502);
  }
}

export function POST(request: Request) { return mutate(request, false); }
export function DELETE(request: Request) { return mutate(request, true); }
