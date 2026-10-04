export const dynamic = "force-dynamic";

export function GET() {
  const config = JSON.stringify({
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
    PASSWORD_SIGN_IN: process.env.PASSWORD_SIGN_IN === "true",
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return new Response(`window.__OPENJURY_CONFIG__ = ${config};\n`, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
