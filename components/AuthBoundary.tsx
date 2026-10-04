"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import Button from "@/components/Button";
import Card from "@/components/Card";

const AuthContext = createContext<{ client: SupabaseClient; session: Session } | null>(null);

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Authentication is required.");
  return auth;
}

export default function AuthBoundary({ children, demo }: { children: ReactNode; demo?: ReactNode }) {
  const [client, setClient] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [unconfigured, setUnconfigured] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const currentSession = useRef<Session | null>(null);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let unsubscribe = () => {};
    const authRevision = revision;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const error = hash.get("error_description") || query.get("error_description") || hash.get("error") || query.get("error");
      if (error) {
        setLinkError(`Sign-in link failed: ${error}. Request a new link below.`);
        for (const key of ["error", "error_code", "error_description"]) {
          hash.delete(key);
          query.delete(key);
        }
        window.history.replaceState(null, "", `${window.location.pathname}${query.size ? `?${query}` : ""}${hash.size ? `#${hash}` : ""}`);
      }
      const initialRevision = revision.current;
      try {
        const supabase = getSupabase();
        setClient(supabase);
        const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
          // getSession reports failures that INITIAL_SESSION hides.
          if (!active || event === "INITIAL_SESSION") return;
          revision.current++;
          currentSession.current = nextSession;
          setSession(nextSession);
          setSessionError("");
          setActionError("");
          setMessage("");
          setLoading(false);
        });
        unsubscribe = () => data.subscription.unsubscribe();
        const initialized = await supabase.auth.initialize();
        if (initialized.error) throw initialized.error;
        const result = await supabase.auth.getSession();
        if (active && revision.current === initialRevision) {
          if (result.error) {
            setSession(null);
            setSessionError(`Unable to load your session: ${result.error.message}`);
          } else {
            currentSession.current = result.data.session;
            setSession(result.data.session);
          }
          setLoading(false);
        }
      } catch (error) {
        if (!active || revision.current !== initialRevision) return;
        if (error instanceof Error && error.message.startsWith("Supabase is not configured.")) {
          setUnconfigured(true);
        } else {
          setSessionError(`Unable to load your session: ${error instanceof Error ? error.message : "Check the public Supabase configuration."}`);
        }
        setLoading(false);
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
      authRevision.current++;
      unsubscribe();
    };
  }, []);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || pending) return;
    const requestRevision = revision.current;
    setPending(true);
    setActionError("");
    setMessage("");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/dashboard`, shouldCreateUser: true },
      });
      if (!mounted.current || revision.current !== requestRevision) return;
      if (error) setActionError(`Unable to send sign-in link: ${error.message}`);
      else setMessage("Check your email for a sign-in link. You can close this tab.");
    } catch {
      if (mounted.current && revision.current === requestRevision) setActionError("Unable to send sign-in link. Please try again.");
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function signOut() {
    if (!client || signingOut) return;
    const requestRevision = revision.current;
    setSigningOut(true);
    setActionError("");
    try {
      const { error } = await client.auth.signOut();
      if (!mounted.current) return;
      if (error && (revision.current === requestRevision || !currentSession.current)) {
        setActionError(`Unable to complete sign out on the server: ${error.message}. Your local session may already be cleared.`);
      } else if (!error && revision.current === requestRevision) {
        currentSession.current = null;
        setSession(null);
      }
    } catch {
      if (mounted.current && (revision.current === requestRevision || !currentSession.current)) setActionError("Unable to complete sign out. Your local session may already be cleared.");
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  if (loading) return <p role="status">Loading your session…</p>;
  if (unconfigured) {
    return (
      <>
        <Card title="Setup required">
          <p>Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY at runtime, or NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. Use only the public anon key.</p>
          <p>Authentication and real groups are unavailable. These previews contain no private data.</p>
          <Link href="/dashboard" className="underline">Explore your dashboard</Link>
        </Card>
        {demo}
      </>
    );
  }
  if (sessionError) {
    return <Card title="Session unavailable"><p role="alert">{sessionError}</p><Button onClick={() => window.location.reload()}>Retry session</Button></Card>;
  }
  return (
    <>
      {linkError && <p role="alert">{linkError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {session && client ? (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <p className="break-all">Signed in as {session.user.email || session.user.id}</p>
            <Button disabled={signingOut} onClick={signOut}>{signingOut ? "Signing out…" : "Sign out"}</Button>
          </div>
          {signingOut ? <p role="status">Signing out…</p> : (
            <AuthContext.Provider value={{ client, session }}>
              <div key={`${session.user.id}:${session.access_token}`} className="space-y-6">{children}</div>
            </AuthContext.Provider>
          )}
        </>
      ) : (
        <Card title="Sign in to OpenJury">
          <p>Sign in with your email to view your groups. New accounts are welcome.</p>
          <form onSubmit={requestLink} className="space-y-4" aria-busy={pending}>
            <label className="block">Email address
              <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 block w-full rounded border border-slate-300 p-2" />
            </label>
            <Button type="submit" disabled={pending}>{pending ? "Sending link…" : "Send sign-in link"}</Button>
          </form>
          {(pending || message) && <p role="status">{pending ? "Sending your sign-in link…" : message}</p>}
        </Card>
      )}
    </>
  );
}
