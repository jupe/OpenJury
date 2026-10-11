import { createClient } from "@supabase/supabase-js";
import { backendConfiguration, bearer, boundedBody, json, pushClient, uuidPattern } from "@/lib/web-push";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const token = bearer(request);
  if (!token) return json({ error: "Authentication required" }, 401);
  const config = backendConfiguration(true);
  if (!config) return json({ error: "Account deletion is not configured" }, 503);
  let userId: string;
  try {
    const body = await boundedBody(request) as { userId?: unknown } | null;
    if (!body || typeof body !== "object" || typeof body.userId !== "string"
      || !uuidPattern.test(body.userId)) return json({ error: "Invalid account" }, 400);
    userId = body.userId;
  } catch {
    return json({ error: "Invalid account" }, 400);
  }
  try {
    const client = pushClient(config.url, config.anonKey, token);
    const { data, error: authError } = await client.auth.getUser(token);
    if (authError || !data.user) return json({ error: "Authentication required" }, 401);
    const { data: media, error: accessError } = await client.rpc("prepare_account_deletion", { p_user_id: userId });
    if (accessError) return json({ error: "Account deletion access required" }, 403);
    if (!Array.isArray(media)) throw new Error("Invalid media response");
    const storage = createClient(config.url, config.serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).storage.from("competition-submissions");
    let remaining = media;
    let batches = 0;
    while (remaining.length > 0) {
      if (++batches > 100) throw new Error("Media cleanup limit reached; retry deletion");
      for (let offset = 0; offset < remaining.length; offset += 100) {
        const { error } = await storage.remove(remaining.slice(offset, offset + 100).map((item: { name: string }) => item.name));
        if (error) return json({ error: "Unable to remove account media. Please try again." }, 502);
      }
      const result = await client.rpc("get_account_deletion_media", { p_user_id: userId });
      if (result.error || !Array.isArray(result.data)) throw new Error("Unable to verify media cleanup");
      if (result.data.length && result.data[0].name === remaining[0].name) throw new Error("Media cleanup made no progress");
      remaining = result.data;
    }
    const { error } = await client.rpc("delete_account", { p_user_id: userId });
    if (error) return json({ error: "Unable to delete account. Please try again." }, error.code === "42501" ? 403 : 409);
    return json({ deleted: true });
  } catch {
    return json({ error: "Unable to delete account. Please try again." }, 502);
  }
}
