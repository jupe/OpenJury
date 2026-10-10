import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare global {
  interface Window {
    __OPENJURY_CONFIG__?: {
      SUPABASE_URL?: string;
      SUPABASE_ANON_KEY?: string;
      PASSWORD_SIGN_IN?: boolean;
      AUTH_GOOGLE_ENABLED?: boolean;
      AUTH_FACEBOOK_ENABLED?: boolean;
      AUTH_GITHUB_ENABLED?: boolean;
    };
  }
}

let client: SupabaseClient | undefined;

const socialProviders = [
  { id: "google", name: "Google", flag: "AUTH_GOOGLE_ENABLED" },
  { id: "facebook", name: "Facebook", flag: "AUTH_FACEBOOK_ENABLED" },
  { id: "github", name: "GitHub", flag: "AUTH_GITHUB_ENABLED" },
] as const;

export type SocialProvider = (typeof socialProviders)[number];

export function getEnabledSocialProviders(): SocialProvider[] {
  const config = typeof window !== "undefined" ? window.__OPENJURY_CONFIG__ : undefined;
  return socialProviders.filter((provider) => config?.[provider.flag] === true);
}

/** Password sign-in is only enabled for disposable dev previews with a seeded account. */
export function passwordSignInEnabled(): boolean {
  return typeof window !== "undefined" && window.__OPENJURY_CONFIG__?.PASSWORD_SIGN_IN === true;
}

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
