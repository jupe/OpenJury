import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare global {
  interface Window {
    __OPENJURY_CONFIG__?: {
      SUPABASE_URL?: string;
      SUPABASE_ANON_KEY?: string;
    };
  }
}

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const config =
    typeof window === "undefined"
      ? {
          SUPABASE_URL: process.env.SUPABASE_URL,
          SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
        }
      : window.__OPENJURY_CONFIG__;
  const url = config?.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = config?.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY at runtime, or NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. Use only the public anon key.",
    );
  }

  client = createClient(url, key);
  return client;
}
