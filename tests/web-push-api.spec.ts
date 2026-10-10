import { expect, test } from "@playwright/test";
import { GET, POST as subscribe, DELETE } from "../app/api/push/subscriptions/route";
import { POST as drain } from "../app/api/competitions/[competitionId]/push/route";
import { POST as dispatch } from "../app/api/push/dispatch/route";
import { notification, pushSender, validEndpoint, validSubscription } from "../lib/web-push";

test.describe.configure({ mode: "serial" });
const competitionId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const keys = pushSender.generateVAPIDKeys();
const subscription = { endpoint: "https://web.push.apple.com/private-device-token",
  keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 1).toString("base64url") } };
const env = {
  SUPABASE_URL: "https://backend.example.com", SUPABASE_ANON_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key", WEB_PUSH_PUBLIC_KEY: keys.publicKey,
  WEB_PUSH_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: "mailto:admin@example.com",
  WEB_PUSH_DISPATCH_SECRET: "test-only-dispatch-secret-of-at-least-32-characters",
};
let previous: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let originalSend: typeof pushSender.sendNotification;
let calls: { path: string; headers: Headers; body: Record<string, unknown> }[];
let rpcError: string | null;
let authStatus: number;
let providerStatus: number;
let active: boolean;
let claimed: boolean;
let complete: boolean;
let ack: boolean;
let claimError: boolean;
let deliveries: number;
let payload: Record<string, unknown>;
let extraClaims: number;
let clockOffset: number;
let originalNow: typeof Date.now;
let scheduled: boolean;
let dispatcherListCalls: number;

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = []; rpcError = null; authStatus = 200; providerStatus = 201;
  active = true; claimed = false; complete = true; ack = true; claimError = false; deliveries = 0;
  extraClaims = 0; clockOffset = 0; originalNow = Date.now;
  scheduled = false; dispatcherListCalls = 0;
  originalSend = pushSender.sendNotification;
  pushSender.sendNotification = async (sub, body, options) => {
    deliveries++;
    expect(sub).toEqual(subscription);
    expect(options?.vapidDetails).toEqual({ subject: env.WEB_PUSH_SUBJECT,
      publicKey: keys.publicKey, privateKey: keys.privateKey });
    expect(options?.timeout).toBeLessThanOrEqual(5000);
    payload = JSON.parse(String(body));
    if (providerStatus !== 201) throw { statusCode: providerStatus };
    return { statusCode: 201, body: "", headers: {} };
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const call = { path, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) };
    calls.push(call);
    if (path === "/auth/v1/user") return Response.json(authStatus === 200 ? { id, aud: "authenticated" }
      : { message: "Invalid session" }, { status: authStatus });
    const rpc = path.split("/").pop();
    if (["authorize_competition_push", "save_my_push_subscription", "delete_my_push_subscription"].includes(rpc!)) {
      return rpcError ? Response.json({ code: rpcError, message: "Private detail" }, { status: 400 })
        : new Response(null, { status: 204 });
    }
    if (["process_remote_competition_deadlines", "process_scheduled_competition_publications"].includes(rpc!)) {
      scheduled = true;
      expect(call.headers.get("apikey")).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
      return Response.json(1);
    }
    if (rpc === "pending_competition_push_dispatch") {
      dispatcherListCalls++;
      return Response.json(dispatcherListCalls === 1 ? [{ competition_id: competitionId }] : []);
    }
    if (rpc === "all_competition_push_sent") return Response.json(complete);
    expect(scheduled || calls.some((item) => item.path.endsWith("/authorize_competition_push"))).toBe(true);
    expect(call.headers.get("apikey")).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
    if (rpc === "claim_competition_push") {
      if (claimError) return Response.json({ message: "Private failure" }, { status: 500 });
      if (claimed && extraClaims <= 0) return Response.json([]);
      if (claimed) extraClaims--;
      claimed = true;
      return Response.json([{ id, claim_token: id, event_id: id, phase: "voting", locale: "fi", subscription }]);
    }
    if (rpc === "competition_push_claim_active") return Response.json(active);
    if (rpc === "finish_competition_push") {
      if (clockOffset) clockOffset = 24_000;
      return Response.json(ack);
    }
    if (rpc === "competition_push_sent") return Response.json(complete);
    throw new Error(`Unexpected upstream ${path}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  pushSender.sendNotification = originalSend;
  Date.now = originalNow;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function request(body?: unknown, token = "session") {
  return new Request("https://jury.example.com/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json",
      ...(token ? { authorization: ["Bearer", token].join(" ") } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function send(token = "session", target = competitionId) {
  return drain(request(undefined, token), { params: Promise.resolve({ competitionId: target }) });
}

test("public key response is no-store and never exposes private configuration", async () => {
  const response = GET();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ publicKey: keys.publicKey });
  delete process.env.WEB_PUSH_PUBLIC_KEY;
  expect(GET().status).toBe(503);
  process.env.WEB_PUSH_PUBLIC_KEY = "invalid";
  expect(GET().status).toBe(503);
  process.env.WEB_PUSH_PUBLIC_KEY = keys.publicKey;
  for (const name of ["WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_SUBJECT", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const value = process.env[name];
    delete process.env[name];
    expect(GET().status).toBe(503);
    process.env[name] = value;
  }
  expect(calls).toEqual([]);
});

test("registration requires delivery configuration but disabling remains available", async () => {
  for (const name of ["WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_SUBJECT", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const value = process.env[name];
    delete process.env[name];
    expect(GET().status).toBe(503);
    expect((await subscribe(request({ subscription, locale: "en" }))).status).toBe(503);
    expect(await (await DELETE(request({ endpoint: subscription.endpoint }))).json()).toEqual({ subscribed: false });
    process.env[name] = value;
  }
});

test("rejects SSRF destinations, URL tricks, and invalid or noncanonical keys", () => {
  for (const endpoint of [
    "http://web.push.apple.com/x", "https://127.0.0.1/x", "https://push.apple.com/x",
    "https://web.push.apple.com.evil.test/x", "https://evilpush.apple.com/x",
    "https://user@web.push.apple.com/x", "https://web.push.apple.com:8443/x",
    "https://web.push.apple.com/x#", "https://web.push.apple.com/x#fragment",
    "https://web.push.apple.com\\@evil.test/x", "https://web.push.apple.com/",
    "https://web.push.apple.com/" + "x".repeat(2048),
  ]) expect(validEndpoint(endpoint), endpoint).toBe(false);
  expect(validEndpoint("https://eu.push.apple.com/device?token=abc")).toBe(true);
  expect(validSubscription(subscription)).toBe(true);
  for (const p256dh of ["x", keys.publicKey + "=", Buffer.alloc(65, 4).toString("base64url")]) {
    expect(validSubscription({ ...subscription, keys: { ...subscription.keys, p256dh } })).toBe(false);
  }
  for (const auth of ["x", subscription.keys.auth + "=", subscription.keys.auth.slice(0, -1) + "B"]) {
    expect(validSubscription({ ...subscription, keys: { ...subscription.keys, auth } })).toBe(false);
  }
});

test("subscription mutations authenticate and use caller-scoped RPCs without service reads", async () => {
  expect(await (await subscribe(request({ subscription, locale: "fi" }))).json()).toEqual({ subscribed: true });
  expect(await (await DELETE(request({ subscription: { endpoint: subscription.endpoint } }))).json()).toEqual({ subscribed: false });
  expect(await (await DELETE(request({ endpoint: subscription.endpoint }))).json()).toEqual({ subscribed: false });
  const saves = calls.filter((call) => call.path.endsWith("/save_my_push_subscription"));
  expect(saves[0].body).toEqual({ p_endpoint: subscription.endpoint, p_p256dh: keys.publicKey,
    p_auth: subscription.keys.auth, p_locale: "fi" });
  for (const call of calls) {
    expect(call.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
    expect(call.headers.get("authorization")).toBe(["Bearer", "session"].join(" "));
  }
});

test("malformed bodies and unauthenticated subscriptions do not access upstream", async () => {
  expect((await subscribe(request({ subscription, locale: "en" }, ""))).status).toBe(401);
  for (const body of [null, {}, { subscription, locale: "sv" }, { subscription, locale: ["en"] },
    { subscription: { ...subscription, endpoint: "https://evil.test/x" }, locale: "en" }]) {
    expect((await subscribe(request(body))).status).toBe(400);
  }
  expect((await subscribe(request({ text: "x".repeat(5000) }))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("subscription auth, owner conflicts, cap and database errors map safely", async () => {
  authStatus = 401;
  expect((await subscribe(request({ subscription, locale: "en" }))).status).toBe(401);
  authStatus = 200;
  for (const [code, status] of [["23505", 409], ["54000", 429], ["42501", 403], ["22023", 400], ["XX000", 502]] as const) {
    rpcError = code;
    const response = await subscribe(request({ subscription, locale: "en" }));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("Private");
  }
});

test("drain rejects invalid auth, configuration, IDs and non-admins before any service read", async () => {
  expect((await send("")).status).toBe(401);
  expect((await send("session", "bad")).status).toBe(400);
  process.env.WEB_PUSH_PRIVATE_KEY = pushSender.generateVAPIDKeys().privateKey;
  expect((await send()).status).toBe(503);
  process.env.WEB_PUSH_PRIVATE_KEY = keys.privateKey;
  authStatus = 401;
  expect((await send()).status).toBe(401);
  authStatus = 200; rpcError = "42501";
  expect((await send()).status).toBe(403);
  expect(calls.every((call) => call.headers.get("apikey") === env.SUPABASE_ANON_KEY)).toBe(true);
  expect(deliveries).toBe(0);
});

test("authorized drain delivers visible generic localized payload and acknowledges the lease", async () => {
  expect(await (await send()).json()).toEqual({ notificationsSent: true });
  expect(payload).toEqual(notification(competitionId, id, "voting", "fi"));
  expect(payload).toMatchObject({ title: "OpenJury", body: "Äänestys on nyt avoinna.",
    url: `/competition/${competitionId}` });
  expect(calls.find((call) => call.path.endsWith("/finish_competition_push"))?.body).toEqual({
    p_id: id, p_claim_token: id, p_outcome: "sent",
  });
});

test("expired devices prune, transient provider failures retry, and revoked membership skips delivery", async () => {
  for (const status of [404, 410, 429, 500]) {
    claimed = false; calls = []; providerStatus = status;
    expect(await (await send()).json()).toEqual({ notificationsSent: status === 404 || status === 410 });
    expect(calls.find((call) => call.path.endsWith("/finish_competition_push"))?.body.p_outcome)
      .toBe(status === 404 || status === 410 ? "expired" : "retry");
  }
  claimed = false; active = false; deliveries = 0;
  expect(await (await send()).json()).toEqual({ notificationsSent: true });
  expect(deliveries).toBe(0);
  expect(calls.filter((call) => call.path.endsWith("/finish_competition_push")).at(-1)?.body.p_outcome).toBe("skipped");
});

test("claim failures, lost acknowledgements and pending leases preserve retry outcomes", async () => {
  claimError = true;
  expect(await (await send()).json()).toEqual({ notificationsSent: false });
  claimError = false; ack = false;
  expect(await (await send()).json()).toEqual({ notificationsSent: false });
  ack = true; complete = false;
  expect(await (await send()).json()).toEqual({ notificationsSent: false });
  expect(deliveries).toBe(1);
});

test("drain bounds delivery count and request time while preserving pending work", async () => {
  extraClaims = 100; complete = false;
  expect(await (await send()).json()).toEqual({ notificationsSent: false });
  expect(deliveries).toBe(50);
  const now = originalNow();
  claimed = false; deliveries = 0; clockOffset = 1;
  Date.now = () => now + clockOffset;
  expect(await (await send()).json()).toEqual({ notificationsSent: false });
  expect(deliveries).toBe(1);
});

test("scheduled dispatcher rejects invalid secrets before service reads", async () => {
  expect((await dispatch(request(undefined, "invalid"))).status).toBe(401);
  expect((await dispatch(request(undefined, ""))).status).toBe(401);
  process.env.WEB_PUSH_DISPATCH_SECRET = "";
  expect((await dispatch(request(undefined, "invalid"))).status).toBe(503);
  expect(calls).toEqual([]);
});

test("scheduled dispatcher advances due phases and publications then delivers without user access", async () => {
  expect(await (await dispatch(request(undefined, env.WEB_PUSH_DISPATCH_SECRET))).json()).toEqual({ notificationsSent: true });
  expect(calls.slice(0, 3).map((call) => call.path.split("/").pop())).toEqual([
    "process_remote_competition_deadlines", "process_scheduled_competition_publications", "pending_competition_push_dispatch",
  ]);
  expect(calls.every((call) => call.headers.get("apikey") === env.SUPABASE_SERVICE_ROLE_KEY)).toBe(true);
  expect(calls.some((call) => call.path === "/auth/v1/user")).toBe(false);
  expect(deliveries).toBe(1);
});
