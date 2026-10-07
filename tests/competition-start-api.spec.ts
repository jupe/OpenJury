import { expect, test } from "@playwright/test";
import { mailer } from "../lib/mailer";
import { POST } from "../app/api/competitions/[competitionId]/start/route";

test.describe.configure({ mode: "serial" });

const competitionId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const claimToken = "33333333-3333-4333-8333-333333333333";
const env = {
  SUPABASE_URL: "https://backend.example.com",
  SUPABASE_ANON_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "private-test-service-key",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "jury@example.com",
  SMTP_PASS: "private-smtp-password",
  SMTP_ADMIN_EMAIL: "jury@example.com",
  APP_URL: "https://jury.example.com",
};
let previous: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let originalCreateTransport: typeof mailer.createTransport;
let transportsClosed: number;
type Call = { url: string; headers: Headers; body: Record<string, unknown>; at: number; config?: unknown };
let calls: Call[];
let authStatus: number;
let startError: string | null;
let providerStatus: number;
let providerThrows: boolean;
let finishFails: boolean;
let claimFails: boolean;
let completed: boolean;
let claimed: boolean;
let originalNow: typeof Date.now;
let clockOffset: number;
let finishAdvance: number;
let extraRecipient: boolean;
const payload = {
  from: env.SMTP_ADMIN_EMAIL,
  to: ["private-member@example.com"],
  subject: "Competition started: Bake-off",
  text: `The competition "Bake-off" in "Baking club" has started.\nhttps://jury.example.com/competition/${competitionId}`,
};

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = [];
  authStatus = 200;
  startError = null;
  providerStatus = 200;
  providerThrows = false;
  finishFails = false;
  claimFails = false;
  completed = true;
  claimed = false;
  clockOffset = 0;
  finishAdvance = 0;
  extraRecipient = false;
  originalNow = Date.now;
  originalCreateTransport = mailer.createTransport;
  transportsClosed = 0;
  mailer.createTransport = (config) => ({
    async sendMail(message) {
      calls.push({ url: "smtp://send", headers: new Headers(), body: message as unknown as Record<string, unknown>, at: Date.now(), config });
      if (providerThrows) throw Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
      if (providerStatus !== 200) {
        throw Object.assign(new Error(`Private failure for ${message.to[0]}`), {
          code: "EMESSAGE", responseCode: providerStatus, response: `${providerStatus} Private failure`,
        });
      }
      return { messageId: "<provider-id@smtp.example.com>" };
    },
    close() { transportsClosed++; },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")), at: Date.now() };
    calls.push(call);
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") {
      return Response.json(authStatus === 200 ? { id: "admin", aud: "authenticated" }
        : { message: "Invalid token" }, { status: authStatus });
    }
    if (path === "/rest/v1/rpc/start_competition") {
      return startError
        ? Response.json({ code: startError, message: "Private database detail" }, { status: 400 })
        : Response.json("submission");
    }
    if (path === "/rest/v1/rpc/claim_competition_start_email") {
      if (claimFails) return Response.json({ message: "Private claim error" }, { status: 500 });
      if (claimed) return Response.json([]);
      if (extraRecipient) {
        extraRecipient = false;
        return Response.json([{
          id: "44444444-4444-4444-8444-444444444444",
          claim_token: claimToken, payload: { ...payload, to: ["second-private-member@example.com"] },
        }]);
      }
      claimed = true;
      return Response.json([{ id: recipientId, claim_token: claimToken, payload }]);
    }
    if (path === "/rest/v1/rpc/finish_competition_start_email") {
      clockOffset += finishAdvance;
      return finishFails ? Response.json({ message: "Private finish error" }, { status: 500 })
        : new Response(null, { status: 204 });
    }
    if (path === "/rest/v1/rpc/competition_start_emails_sent") return Response.json(completed);
    throw new Error(`Unexpected upstream: ${url}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  mailer.createTransport = originalCreateTransport;
  Date.now = originalNow;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function request(token = "test-session-token", id = competitionId) {
  return POST(new Request(`https://attacker.example/api/competitions/${id}/start`, {
    method: "POST", headers: token ? { authorization: ["Bearer", token].join(" ") } : {},
  }), { params: Promise.resolve({ competitionId: id }) });
}

test("rejects missing sessions and malformed IDs without upstream calls", async () => {
  expect((await request("")).status).toBe(401);
  expect((await request("session", "invalid")).status).toBe(400);
  expect(calls).toEqual([]);
});

test("configuration fails closed before starting", async () => {
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "SMTP_HOST", "SMTP_ADMIN_EMAIL", "APP_URL"]) {
    delete process.env[name];
    expect((await request()).status).toBe(503);
    process.env[name] = env[name as keyof typeof env];
  }
  for (const value of ["https://example.com/path", "https://user@example.com", "http://example.com", "https://example.com/?next=evil"]) {
    process.env.APP_URL = value;
    expect((await request()).status).toBe(503);
  }
  process.env.APP_URL = env.APP_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "invalid key with whitespace";
  expect((await request()).status).toBe(503);
  expect(calls).toEqual([]);
});

test("verifies sessions and maps permission/state failures without delivery", async () => {
  authStatus = 401;
  expect((await request()).status).toBe(401);
  expect(calls).toHaveLength(1);
  authStatus = 200;
  for (const [code, expectedStatus] of [["42501", 403], ["55000", 409], ["XX000", 502]] as const) {
    startError = code;
    const response = await request();
    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).not.toContain("Private");
  }
  expect(calls.some((call) => call.url === "smtp://send" || call.url.includes("claim_competition"))).toBe(false);
});

test("starts as the user and privately delivers frozen plain text with service-only RPCs", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ started: true, notificationsSent: true });
  const start = calls.find((call) => call.url.endsWith("/start_competition"))!;
  expect(start.body).toEqual({ p_competition_id: competitionId, p_notify: true });
  expect(start.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
  expect(start.headers.get("authorization")).toBe(["Bearer", "test-session-token"].join(" "));
  const claim = calls.find((call) => call.url.endsWith("/claim_competition_start_email"))!;
  expect(claim.headers.get("apikey")).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
  expect(claim.body).toEqual({
    p_competition_id: competitionId, p_from: env.SMTP_ADMIN_EMAIL, p_origin: env.APP_URL,
  });
  const email = calls.find((call) => call.url === "smtp://send")!;
  expect(email.body).toEqual({ ...payload, from: { name: "OpenJury", address: env.SMTP_ADMIN_EMAIL } });
  expect(email.body).not.toHaveProperty("html");
  expect(email.config).toMatchObject({ host: env.SMTP_HOST, port: 587, user: env.SMTP_USER });
  expect(email.body.text).not.toContain("attacker.example");
  expect(transportsClosed).toBe(1);
  expect(calls.find((call) => call.url.endsWith("/finish_competition_start_email"))!.body).toEqual({
    p_id: recipientId, p_claim_token: claimToken, p_sent: true,
  });
});

test("SMTP failures preserve successful start and retry sends the same frozen payload", async () => {
  providerStatus = 429;
  const failed = await request();
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.find((call) => call.url.endsWith("/finish_competition_start_email"))!.body.p_sent).toBe(false);
  providerStatus = 200;
  claimed = false;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  const emails = calls.filter((call) => call.url === "smtp://send");
  expect(emails).toHaveLength(2);
  expect(emails[0].body).toEqual(emails[1].body);
});

test("network, claim, acknowledgement and pending leases return partial success without private details", async () => {
  for (const failure of ["network", "claim", "finish", "pending"]) {
    claimed = false;
    providerThrows = failure === "network";
    claimFails = failure === "claim";
    finishFails = failure === "finish";
    completed = failure !== "pending";
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ started: true, notificationsSent: false });
  }
});

test("already delivered or leased outbox never sends without a claim", async () => {
  claimed = true;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  expect(calls.some((call) => call.url === "smtp://send")).toBe(false);
  completed = false;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.some((call) => call.url === "smtp://send")).toBe(false);
});

test("request time budget stops claiming more recipients and preserves partial success", async () => {
  const now = originalNow();
  Date.now = () => now + clockOffset;
  finishAdvance = 23_001;
  completed = false;
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ started: true, notificationsSent: false });
  expect(calls.filter((call) => call.url.endsWith("/claim_competition_start_email"))).toHaveLength(1);
  expect(calls.filter((call) => call.url === "smtp://send")).toHaveLength(1);
});

test("paces multiple messages and reuses one SMTP connection per request", async () => {
  extraRecipient = true;
  expect(await (await request()).json()).toEqual({ started: true, notificationsSent: true });
  const attempts = calls.filter((call) => call.url === "smtp://send");
  expect(attempts).toHaveLength(2);
  expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(550);
  expect(transportsClosed).toBe(1);
});
