import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Built once: the in-browser demo database runs the real migrations on top of
// small stand-ins for Supabase's auth, storage and realtime schemas.
export const dynamic = "force-static";

export async function GET() {
  const root = process.cwd();
  const migrations = path.join(root, "supabase", "migrations");
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const parts = [await readFile(path.join(root, "lib", "demo", "supabaseShim.sql"), "utf8")];
  for (const name of files) parts.push(`-- ${name}\n${await readFile(path.join(migrations, name), "utf8")}`);
  return new Response(parts.join("\n\n"), {
    headers: { "Content-Type": "application/sql; charset=utf-8" },
  });
}
