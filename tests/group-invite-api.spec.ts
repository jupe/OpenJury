import { expect, test } from "@playwright/test";
import { mailer } from "../lib/mailer";
import { POST } from "../app/api/groups/[groupId]/invite/route";

test.describe.configure({ mode: "serial" });

const groupId = "11111111-1111-4111-8111-111111111111";
const env = {
  SUPABASE_URL: "https://backend.example.com",
  SUPABASE_ANON_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "",
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
let calls: Array<{ url: string; headers: Headers; body: Record<string, unknown>; at?: number; config?: unknown }>;
let authStatus: number;
let rpcError: string | null;
let providerStatus: number;
let providerThrows: boolean;
let groupFails: boolean;
let linkStatus: number;
let missingLinkToken: boolean;
let generatedCode: unknown;
let providerEchoesSecrets: boolean;
const serviceKey = "private-service-test-key";
const linkToken = "private-invitation-test-token";
const emailCode = "084219";

test.beforeEach(() => {
  previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  calls = [];
  authStatus = 200;
  rpcError = null;
  providerStatus = 200;
  providerThrows = false;
  groupFails = false;
  linkStatus = 200;
  missingLinkToken = false;
  generatedCode = emailCode;
  providerEchoesSecrets = false;
  originalCreateTransport = mailer.createTransport;
  transportsClosed = 0;
  mailer.createTransport = (config) => ({
    async sendMail(message) {
      calls.push({ url: "smtp://send", headers: new Headers(), body: message as unknown as Record<string, unknown>, at: Date.now(), config });
      if (providerThrows) throw Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
      if (providerStatus !== 200) {
        const echoed = providerEchoesSecrets ? ` ${emailCode} ${linkToken}` : "";
        throw Object.assign(new Error(`Private failure for ${message.to[0]}${echoed}`), {
          code: "EMESSAGE", responseCode: providerStatus, response: `${providerStatus} Private failure${echoed}`,
        });
      }
      return { messageId: "<provider-id@smtp.example.com>" };
    },
    close() { transportsClosed++; },
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body || "{}")) });
    const path = new URL(url).pathname;
    if (path === "/auth/v1/user") {
      return Response.json(authStatus === 200 ? { id: "admin", aud: "authenticated" }
        : { message: "Private auth failure" }, { status: authStatus });
    }
    if (path === "/rest/v1/rpc/invite_group_member_by_email") {
      return rpcError ? Response.json({ code: rpcError, message: "Private database detail" }, { status: 400 })
        : new Response(null, { status: 204 });
    }
    if (path === "/rest/v1/groups") {
      return groupFails ? Response.json({ message: "Private group failure" }, { status: 500 })
        : Response.json({ name: "Baking club" });
    }
    if (path === "/auth/v1/admin/generate_link") {
      return Response.json(linkStatus === 200 ? {
        id: "recipient", email: "new@example.com",
        hashed_token: missingLinkToken ? undefined : linkToken,
        email_otp: generatedCode,
        verification_type: "signup",
        action_link: "https://attacker.example/never-use-provider-link",
      } : { message: `Private failure: ${linkToken} ${emailCode}` }, { status: linkStatus });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  mailer.createTransport = originalCreateTransport;
  for (const name of Object.keys(env)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function request(email: unknown = " NEW@example.com ", token = "test-session-token", id = groupId, body?: string) {
  return POST(new Request(`https://attacker.example/api/groups/${id}/invite`, {
    method: "POST",
    headers: token ? { authorization: ["Bearer", token].join(" ") } : {},
    body: body ?? JSON.stringify({ email }),
  }), { params: Promise.resolve({ groupId: id }) });
}

test("rejects missing sessions and invalid IDs or addresses before upstream calls", async () => {
  expect((await request("valid@example.com", "")).status).toBe(401);
  expect((await request("valid@example.com", "session", "invalid")).status).toBe(400);
  expect((await request("valid@example.com", "session", groupId, "{")).status).toBe(400);
  for (const email of [null, 42, "", "invalid", "a@b.com\nbcc@evil.com", "a".repeat(321) + "@example.com"]) {
    expect((await request(email)).status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("missing or unsafe configuration fails before saving a pending invite", async () => {
  for (const name of ["SMTP_HOST", "SMTP_ADMIN_EMAIL", "APP_URL"]) {
    delete process.env[name];
    expect((await request()).status).toBe(503);
    process.env[name] = env[name as keyof typeof env];
  }
  for (const url of ["https://example.com/path", "https://user@example.com", "http://example.com", "https://example.com/?next=evil"]) {
    process.env.APP_URL = url;
    expect((await request()).status).toBe(503);
  }
  process.env.APP_URL = env.APP_URL;
  process.env.SMTP_ADMIN_EMAIL = "sender@example.com\r\nBcc: other@example.com";
  expect((await request()).status).toBe(503);
  process.env.SMTP_ADMIN_EMAIL = env.SMTP_ADMIN_EMAIL;
  delete process.env.SMTP_PASS;
  expect((await request()).status).toBe(503);
  expect(calls).toEqual([]);
});

test("authentication and RPC permissions gate email delivery without leaking errors", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  authStatus = 401;
  expect((await request()).status).toBe(401);
  authStatus = 200;
  for (const [code, status] of [["42501", 403], ["22023", 400], ["P0001", 409], ["XX000", 502]] as const) {
    rpcError = code;
    const response = await request();
    expect(response.status).toBe(status);
    if (code === "P0001") {
      expect(await response.json()).toEqual({
        error: "This email is already registered. Use an invite link instead.",
      });
      continue;
    }
    expect(await response.text()).not.toContain("Private");
  }
  expect(calls.some((call) => call.url === "smtp://send")).toBe(false);
  expect(calls.some((call) => new URL(call.url).pathname === "/auth/v1/admin/generate_link")).toBe(false);
});

test("saves under the user's permissions and sends a private invitation to the trusted dashboard URL", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ invited: true, emailSent: true });
  const rpc = calls.find((call) => call.url.endsWith("/invite_group_member_by_email"))!;
  expect(rpc.body).toEqual({ p_group_id: groupId, p_email: "new@example.com" });
  expect(rpc.headers.get("apikey")).toBe(env.SUPABASE_ANON_KEY);
  expect(rpc.headers.get("authorization")).toBe(["Bearer", "test-session-token"].join(" "));
  const email = calls.find((call) => call.url === "smtp://send")!;
  expect(email.config).toMatchObject({ host: env.SMTP_HOST, port: 587, user: env.SMTP_USER, pass: env.SMTP_PASS });
  expect(transportsClosed).toBe(1);
  expect(email.body).toEqual({
    from: { name: "OpenJury", address: env.SMTP_ADMIN_EMAIL },
    to: ["new@example.com"],
    subject: "You have been invited to an OpenJury group",
    text: 'You have been invited to "Baking club" on OpenJury.\nUsing the Home Screen app? Open OpenJury and request a sign-in code inside the app with new@example.com.\nThis invitation does not contain a sign-in code.\n\nSign in with new@example.com to join the group:\nhttps://jury.example.com/dashboard#email=new%40example.com',
  });
  expect(email.body).not.toHaveProperty("html");
  expect(JSON.stringify(email.body)).not.toContain("attacker.example");
  expect(JSON.stringify(email.body)).not.toContain(emailCode);
  expect(calls.some((call) => new URL(call.url).pathname === "/auth/v1/admin/generate_link")).toBe(false);
});

test("authorized invitations deliver a recipient-only sign-in code and link without returning secrets", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  const response = await request(" Person+invite@example.com ");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ invited: true, emailSent: true });
  const generated = calls.find((call) => new URL(call.url).pathname === "/auth/v1/admin/generate_link")!;
  expect(generated.body).toMatchObject({
    type: "magiclink", email: "person+invite@example.com",
  });
  expect(new URL(generated.url).searchParams.get("redirect_to")).toBe("https://jury.example.com/dashboard");
  expect(generated.headers.get("apikey")).toBe(serviceKey);
  expect(generated.headers.get("authorization")).toBe(["Bearer", serviceKey].join(" "));
  expect(calls.findIndex((call) => call === generated)).toBeGreaterThan(
    calls.findIndex((call) => call.url.endsWith("/invite_group_member_by_email")),
  );
  const email = calls.find((call) => call.url === "smtp://send")!;
  expect(email.body.to).toEqual(["person+invite@example.com"]);
  expect(email.body).not.toHaveProperty("html");
  expect(email.body.text).toContain(`Sign-in code: ${emailCode}`);
  expect(email.body.text).toContain("Using the Home Screen app? Open OpenJury and enter this code.");
  expect(email.body.text).toContain("Use the email address person+invite@example.com when entering the code.");
  const link = new URL(String(email.body.text).split("\n").at(-1)!);
  expect(link.origin).toBe(env.APP_URL);
  expect(link.pathname).toBe("/dashboard");
  expect(link.search).toBe("");
  expect(new URLSearchParams(link.hash.slice(1)).get("email")).toBe("person+invite@example.com");
  expect(new URLSearchParams(link.hash.slice(1)).get("token_hash")).toBe(linkToken);
  expect(JSON.stringify(email.body)).not.toContain(serviceKey);
  expect(JSON.stringify(email.body)).not.toContain("attacker.example");
});

test("link or code generation failures preserve the invite without sending broken emails or leaking secrets", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  const lines: string[] = [];
  const { info, error } = console;
  console.info = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  try {
    for (const failure of ["provider", "missing-token", "missing-code", "empty-code", "blank-code", "invalid-code"]) {
      linkStatus = failure === "provider" ? 500 : 200;
      missingLinkToken = failure === "missing-token";
      generatedCode = failure === "missing-code" ? undefined : failure === "empty-code" ? ""
        : failure === "blank-code" ? "   " : failure === "invalid-code" ? 84219 : emailCode;
      const response = await request();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        invited: true, error: "Invitation saved, but email delivery failed. Please retry.",
      });
      expect(calls.some((call) => call.url === "smtp://send")).toBe(false);
    }
  } finally {
    console.info = info;
    console.error = error;
  }
  for (const secret of [emailCode, linkToken, serviceKey, env.SMTP_PASS, "new@example.com"]) {
    expect(lines.join("\n")).not.toContain(secret);
  }
  missingLinkToken = false;
  generatedCode = emailCode;
  expect((await request()).status).toBe(200);
});

test("provider and network failures report pending state and allow explicit resends", async () => {
  for (const failure of ["provider", "network", "group"]) {
    providerStatus = failure === "provider" ? 429 : 200;
    providerThrows = failure === "network";
    groupFails = failure === "group";
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      invited: true, error: "Invitation saved, but email delivery failed. Please retry.",
    });
  }
  providerThrows = false;
  groupFails = false;
  expect(await (await request()).json()).toEqual({ invited: true, emailSent: true });
});

test("logs one diagnostic line per outcome without secrets, tokens, or full addresses", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  const lines: string[] = [];
  const { info, error } = console;
  console.info = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    delete process.env.SMTP_HOST;
    delete process.env.APP_URL;
    await request();
    expect(events().at(-1)).toMatchObject({
      scope: "group-invite", event: "not-configured", groupId, recipientDomain: "example.com",
      reason: "missing APP_URL; missing SMTP_HOST",
    });
    Object.assign(process.env, env);
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;

    rpcError = "42501";
    await request();
    expect(events().at(-1)).toMatchObject({ event: "invite-rejected", code: "42501" });
    rpcError = null;

    providerStatus = 535;
    await request();
    expect(events().slice(-2)).toMatchObject([
      { event: "invite-saved" },
      { event: "smtp-rejected", smtpHost: env.SMTP_HOST, responseCode: 535, response: "535 Private failure",
        error: "Private failure for <recipient>" },
    ]);
    providerStatus = 200;

    groupFails = true;
    await request();
    expect(events().at(-1)).toMatchObject({ event: "unexpected-error", invited: true, error: expect.stringContaining("Group unavailable") });
    groupFails = false;

    providerStatus = 535;
    providerEchoesSecrets = true;
    const failed = await request();
    expect(await failed.json()).toEqual({
      invited: true, error: "Invitation saved, but email delivery failed. Please retry.",
    });
    expect(events().at(-1)).toMatchObject({
      event: "smtp-rejected",
      response: "535 Private failure <sign-in-secret> <sign-in-secret>",
      error: "Private failure for <recipient> <sign-in-secret> <sign-in-secret>",
    });
    providerStatus = 200;
    providerEchoesSecrets = false;

    await request();
    expect(events().at(-1)).toMatchObject({ event: "email-accepted", messageId: "<provider-id@smtp.example.com>" });
    const requestIds = new Set(events().map((event) => event.requestId));
    expect(requestIds.size).toBe(6);
  } finally {
    console.info = info;
    console.error = error;
  }
  const output = lines.join("\n");
  for (const secret of [env.SMTP_PASS, env.SUPABASE_ANON_KEY, serviceKey, linkToken, emailCode, "test-session-token", "new@example.com"]) {
    expect(output).not.toContain(secret);
  }
});
