"use client";

import { PGlite, types, type Transaction } from "@electric-sql/pglite";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { alex, personas } from "@/lib/demo/personas";
import { seedDemo } from "@/lib/demo/seed";

/*
 * Demo mode: an in-browser stand-in for the Supabase client. The real
 * migrations run in PGlite (Postgres compiled to WebAssembly) and persist in
 * IndexedDB, so row-level security and every RPC behave as in production.
 * Only the client surface OpenJury's components use is implemented.
 */

const DATABASE_PREFIX = "openjury-demo-";
const MEDIA_DATABASE = "openjury-demo-media";
const USER_KEY = "openjury-demo-user";
const LOCK_NAME = "openjury-demo-database";
// Bump to rebuild existing demo databases after changing the seed.
const SEED_VERSION = "3";

type ErrorShape = { message: string; code?: string; details?: string; hint?: string };
type Result<T = unknown> = { data: T; error: ErrorShape | null };
type Actor = { id: string | null; email: string | null; role: "anon" | "authenticated" | "service_role" };
type AuthListener = (event: string, session: Session | null) => void;

const ok = <T>(data: T): Result<T> => ({ data, error: null });
const fail = (error: unknown): Result<null> => ({ data: null, error: toError(error) });

function toError(error: unknown): ErrorShape {
  if (error && typeof error === "object" && "message" in error) {
    const { message, code, detail, hint } = error as { message: string; code?: string; detail?: string; hint?: string };
    return { message, code, details: detail, hint };
  }
  return { message: String(error) };
}

function storageGet(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private windows; the demo then forgets the persona.
  }
}

const identifier = /^[a-z_][a-z0-9_]*$/;
function quoteIdent(name: string) {
  if (!identifier.test(name)) throw new Error(`Unsupported identifier: ${name}`);
  return `"${name}"`;
}

// Timestamps are returned as ISO strings and numerics as numbers, like PostgREST.
function toIso(value: string) {
  return value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
}

// Every write is flushed to IndexedDB before it returns, so a quick reload keeps it.
const PGLITE_OPTIONS = {
  parsers: {
    [types.TIMESTAMPTZ]: toIso,
    [types.TIMESTAMP]: toIso,
    [types.NUMERIC]: Number,
  },
};

class DemoDatabase {
  private constructor(readonly db: PGlite) {}

  static async open(): Promise<DemoDatabase> {
    await acquireTabLock();
    const schema = await fetch("/demo-schema.sql", { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error("Unable to load the demo database schema.");
      return response.text();
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SEED_VERSION}\n${schema}`));
    const version = Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const name = `${DATABASE_PREFIX}${version}`;
    // Drop databases from older schema versions; uploaded media is kept unless the seed is rebuilt.
    await deleteDatabases((existing) => existing !== MEDIA_DATABASE && !existing.endsWith(name));

    let db = await PGlite.create(`idb://${name}`, PGLITE_OPTIONS);
    const { rows } = await db.query<{ ready: boolean }>("select to_regclass('demo_meta.state') is not null as ready");
    if (!rows[0].ready) {
      // Missing, or half-built by a reload during seeding: rebuild from a fresh in-memory seed.
      await db.close();
      await deleteDatabases((existing) => existing.endsWith(name));
      await media.clear();
      const seeded = await DemoDatabase.seedInMemory(schema);
      db = await PGlite.create(`idb://${name}`, { ...PGLITE_OPTIONS, loadDataDir: seeded });
    }
    await db.exec("set timezone = 'UTC'");
    const demo = new DemoDatabase(db);
    return demo;
  }

  /**
   * Builds and seeds the database in memory, which is far faster than writing
   * through to IndexedDB, and returns its data directory for one bulk import.
   */
  private static async seedInMemory(schema: string) {
    const db = await PGlite.create(PGLITE_OPTIONS);
    try {
      await db.exec("set timezone = 'UTC'");
      await db.exec(schema);
      await seedDemo(new DemoDatabase(db));
      await db.exec("create schema demo_meta; create table demo_meta.state (seeded_at timestamptz default now()); insert into demo_meta.state default values;");
      return await db.dumpDataDir();
    } finally {
      await db.close().catch(() => undefined);
    }
  }

  /** Runs `work` in a transaction with the same role and JWT claims PostgREST would set. */
  as<T>(actor: Actor, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true), set_config('request.jwt.claim.email', $3, true)",
        [actor.id ?? "", actor.role, actor.email ?? ""],
      );
      await tx.exec(`set local role ${actor.role}`);
      return work(tx);
    });
  }

  private functions = new Map<string, Promise<{ returnsSet: boolean; returnsVoid: boolean; args: Map<string, string> } | null>>();

  private describeFunction(name: string) {
    let described = this.functions.get(name);
    if (!described) {
      described = this.db.query<{ retset: boolean; rettype: string; argnames: string[] | null; argtypes: string[] }>(
        `select p.proretset as retset, p.prorettype::regtype::text as rettype, p.proargnames as argnames,
                array(select format_type(t, null) from unnest(p.proargtypes) as t) as argtypes
         from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1`,
        [name],
      ).then(({ rows }) => {
        if (rows.length !== 1) return null;
        const [row] = rows;
        return {
          returnsSet: row.retset,
          returnsVoid: row.rettype === "void",
          args: new Map((row.argnames ?? []).map((arg, index) => [arg, row.argtypes[index]])),
        };
      });
      this.functions.set(name, described);
    }
    return described;
  }

  async rpc(actor: Actor, name: string, args: Record<string, unknown> = {}): Promise<Result> {
    try {
      const fn = identifier.test(name) ? await this.describeFunction(name) : null;
      if (!fn) return fail({ message: `Could not find the function public.${name}`, code: "PGRST202" });
      const names = Object.keys(args);
      for (const arg of names) {
        if (!fn.args.has(arg)) return fail({ message: `Could not find the function public.${name} with argument ${arg}`, code: "PGRST202" });
      }
      const call = `public.${quoteIdent(name)}(${names.map((arg, index) => `${quoteIdent(arg)} => $${index + 1}::${fn.args.get(arg)}`).join(", ")})`;
      const values = names.map((arg) => args[arg] ?? null);
      return await this.as(actor, async (tx) => {
        if (fn.returnsSet) return ok((await tx.query(`select * from ${call}`, values)).rows);
        const { rows } = await tx.query<{ result: unknown }>(`select ${call} as result`, values);
        return ok(fn.returnsVoid ? null : rows[0]?.result ?? null);
      });
    } catch (error) {
      return fail(error);
    }
  }

  private columns?: Promise<Map<string, Set<string>>>;

  /** Column names per public table, used to resolve embedded resources. */
  tableColumns() {
    this.columns ??= this.db.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
    ).then(({ rows }) => {
      const tables = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!tables.has(row.table_name)) tables.set(row.table_name, new Set());
        tables.get(row.table_name)!.add(row.column_name);
      }
      return tables;
    });
    return this.columns;
  }
}

async function acquireTabLock() {
  if (!navigator.locks) return;
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        reject(new Error("The demo is already open in another tab. Close that tab and reload this page."));
        return;
      }
      resolve();
      // Hold the lock for the lifetime of this tab.
      return new Promise<void>(() => undefined);
    });
  });
}

/** Deletes the demo's IndexedDB databases whose names match `filter`. */
async function deleteDatabases(filter: (name: string) => boolean) {
  const databases = await indexedDB.databases?.().catch(() => []) ?? [];
  await Promise.all(databases
    .map((database) => database.name ?? "")
    .filter((name) => name.includes(DATABASE_PREFIX) && filter(name))
    .map((name) => new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    })));
}

/** Uploaded demo images live in their own IndexedDB store, keyed by bucket and path. */
const media = {
  open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MEDIA_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("objects");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const database = await media.open();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const transaction = database.transaction("objects", mode);
        const request = work(transaction.objectStore("objects"));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  },
  put: (key: string, blob: Blob) => media.run("readwrite", (store) => { store.put(blob, key); }),
  get: (key: string) => media.run<Blob>("readonly", (store) => store.get(key)),
  delete: (key: string) => media.run("readwrite", (store) => { store.delete(key); }),
  clear: () => media.run("readwrite", (store) => { store.clear(); }),
};

/** Splits a PostgREST select list on top-level commas. */
function splitSelect(select: string) {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of select.replace(/\s+/g, "")) {
    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") depth--;
    current += char;
  }
  if (current) items.push(current);
  return items;
}

class QueryBuilder implements PromiseLike<Result> {
  private selectList = "*";
  private filters: [string, unknown, "eq" | "in"][] = [];
  private orders: [string, boolean][] = [];
  private mode: "many" | "maybeSingle" | "single" = "many";

  constructor(private readonly client: DemoClient, private readonly table: string) {}

  select(columns = "*") { this.selectList = columns; return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value, "eq"]); return this; }
  in(column: string, values: unknown[]) { this.filters.push([column, values, "in"]); return this; }
  order(column: string, options: { ascending?: boolean } = {}) { this.orders.push([column, options.ascending !== false]); return this; }
  abortSignal() { return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }
  single() { this.mode = "single"; return this; }

  then<A = Result, B = never>(resolve?: ((value: Result) => A | PromiseLike<A>) | null, reject?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return this.execute().then(resolve, reject);
  }

  private async execute(): Promise<Result> {
    try {
      const database = await this.client.database();
      const tables = await database.tableColumns();
      const columns = tables.get(this.table);
      if (!columns) return fail({ message: `Could not find the table 'public.${this.table}'`, code: "PGRST205" });
      const selected = splitSelect(this.selectList).map((item) => {
        const embed = /^([a-z_]+)\(([a-z_,*]+)\)$/.exec(item);
        if (!embed) return item === "*" ? "t.*" : `t.${quoteIdent(item)}`;
        const [, related, relatedColumns] = embed;
        if (!tables.has(related)) throw new Error(`Could not find a relationship for '${related}'`);
        const fields = relatedColumns.split(",").map((column) => `'${column}', e.${quoteIdent(column)}`).join(", ");
        const toOneKey = `${related.replace(/s$/, "")}_id`;
        if (columns.has(toOneKey)) {
          return `(select json_build_object(${fields}) from public.${quoteIdent(related)} as e where e.id = t.${quoteIdent(toOneKey)}) as ${quoteIdent(related)}`;
        }
        const toManyKey = `${this.table.replace(/s$/, "")}_id`;
        if (!tables.get(related)!.has(toManyKey)) throw new Error(`Could not find a relationship between '${this.table}' and '${related}'`);
        return `coalesce((select json_agg(json_build_object(${fields})) from public.${quoteIdent(related)} as e where e.${quoteIdent(toManyKey)} = t.id), '[]'::json) as ${quoteIdent(related)}`;
      });
      const where = this.filters.map(([column, , operator], index) =>
        `t.${quoteIdent(column)} = ${operator === "in" ? `any($${index + 1})` : `$${index + 1}`}`);
      const sql = `select ${selected.join(", ")} from public.${quoteIdent(this.table)} as t`
        + (where.length ? ` where ${where.join(" and ")}` : "")
        + (this.orders.length ? ` order by ${this.orders.map(([column, ascending]) => `t.${quoteIdent(column)} ${ascending ? "asc" : "desc"}`).join(", ")}` : "");
      const rows = await database.as(this.client.actor(), async (tx) => (await tx.query(sql, this.filters.map(([, value]) => value))).rows);
      if (this.mode === "many") return ok(rows);
      if (rows.length > 1 || (this.mode === "single" && rows.length === 0)) {
        return fail({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" });
      }
      return ok(rows[0] ?? null);
    } catch (error) {
      return fail(error);
    }
  }
}

type BroadcastHandler = { event: string; callback: (message: { type: "broadcast"; event: string; payload: unknown }) => void };

class DemoChannel {
  readonly handlers: BroadcastHandler[] = [];
  constructor(private readonly client: DemoClient, readonly topic: string) {}

  on(_type: "broadcast", filter: { event: string }, callback: BroadcastHandler["callback"]) {
    this.handlers.push({ event: filter.event, callback });
    return this;
  }

  subscribe(callback?: (status: string) => void) {
    this.client.channels.add(this);
    queueMicrotask(() => callback?.("SUBSCRIBED"));
    return this;
  }
}

class DemoClient {
  readonly channels = new Set<DemoChannel>();
  private ready?: Promise<DemoDatabase>;
  private userId: string | null = null;
  private userMetadata = new Map<string, Record<string, unknown>>();
  private listeners = new Set<AuthListener>();

  database() {
    this.ready ??= DemoDatabase.open().then(async (database) => {
      const { rows } = await database.db.query<{ id: string; raw_user_meta_data: Record<string, unknown> | null }>(
        "select id, raw_user_meta_data from auth.users");
      for (const row of rows) this.userMetadata.set(row.id, row.raw_user_meta_data ?? {});
      await database.db.listen("demo_realtime", (payload) => this.broadcast(payload));
      // Stands in for the scheduler that publishes results at their scheduled time.
      const publishDue = () => void database.as({ id: null, email: null, role: "service_role" }, (tx) =>
        tx.query("select public.process_scheduled_competition_publications()")).catch(() => undefined);
      publishDue();
      window.setInterval(publishDue, 15_000);
      return database;
    });
    return this.ready;
  }

  private broadcast(payload: string) {
    const message = JSON.parse(payload) as { topic: string; event: string; payload: unknown };
    for (const channel of this.channels) {
      if (channel.topic !== message.topic) continue;
      for (const handler of channel.handlers) {
        if (handler.event === message.event) handler.callback({ type: "broadcast", event: message.event, payload: message.payload });
      }
    }
  }

  private user() {
    if (!this.userId) return null;
    return personas.find((persona) => persona.id === this.userId)
      ?? { id: this.userId, email: storageGet(`${USER_KEY}:email`) ?? "", name: "" };
  }

  actor(): Actor {
    const user = this.user();
    return user ? { id: user.id, email: user.email, role: "authenticated" } : { id: null, email: null, role: "anon" };
  }

  private session(): Session | null {
    const user = this.user();
    if (!user) return null;
    return {
      access_token: `demo-${user.id}`,
      refresh_token: "demo",
      token_type: "bearer",
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        aud: "authenticated",
        app_metadata: {},
        user_metadata: this.userMetadata.get(user.id) ?? {},
        created_at: new Date(0).toISOString(),
      },
    };
  }

  private signIn(id: string | null, email: string | null = null) {
    this.userId = id;
    storageSet(USER_KEY, id ?? "");
    storageSet(`${USER_KEY}:email`, email);
    const session = this.session();
    for (const listener of this.listeners) listener(session ? "SIGNED_IN" : "SIGNED_OUT", session);
  }

  /** Signs in as an existing demo account, creating one for a new email. */
  private async signInWithEmail(email: string): Promise<Result<null>> {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@")) return fail({ message: "Enter a valid email address." });
    const { db } = await this.database();
    const existing = await db.query<{ id: string }>("select id from auth.users where lower(email) = $1 order by created_at limit 1", [normalized]);
    const { rows } = existing.rows.length ? existing
      : await db.query<{ id: string }>("insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id", [normalized]);
    this.signIn(rows[0].id, normalized);
    return ok(null);
  }

  async close() {
    const database = await this.ready?.catch(() => undefined);
    await database?.db.close().catch(() => undefined);
  }

  switchPersona(id: string) {
    this.signIn(id);
  }

  readonly auth = {
    initialize: async () => {
      await this.database();
      const stored = storageGet(USER_KEY);
      this.userId = stored === null ? alex.id : stored || null;
      return { error: null };
    },
    getSession: async () => ok({ session: this.session() }),
    updateUser: async ({ data }: { data: { display_name: string | null } }) => {
      const actor = this.actor();
      if (!actor.id) return fail({ message: "Authentication is required." });
      try {
        const database = await this.database();
        const { rows } = await database.db.query<{ raw_user_meta_data: Record<string, unknown> }>(
          `update auth.users
           set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('display_name', $2::text)
           where id = $1 returning raw_user_meta_data`,
          [actor.id, data.display_name],
        );
        if (!rows.length) return fail({ message: "Account not found." });
        this.userMetadata.set(actor.id, rows[0].raw_user_meta_data);
        const session = this.session();
        if (this.userId !== actor.id || !session) return fail({ message: "Your session has changed." });
        for (const listener of this.listeners) listener("USER_UPDATED", session);
        return ok({ user: session.user });
      } catch (error) {
        return fail(error);
      }
    },
    onAuthStateChange: (callback: AuthListener) => {
      this.listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => { this.listeners.delete(callback); } } } };
    },
    signOut: async () => { this.signIn(null); return { error: null }; },
    signInWithOtp: async ({ email }: { email: string }) => {
      try { return await this.signInWithEmail(email); } catch (error) { return fail(error); }
    },
    signInWithPassword: async ({ email }: { email: string }) => {
      try { return await this.signInWithEmail(email); } catch (error) { return fail(error); }
    },
  };

  from(table: string) {
    return new QueryBuilder(this, table);
  }

  rpc(name: string, args?: Record<string, unknown>) {
    const result = this.database().then((database) => database.rpc(this.actor(), name, args));
    // Supports the chained abortSignal() call; demo queries are too quick to cancel.
    return Object.assign(result, { abortSignal: () => result });
  }

  channel(topic: string) {
    return new DemoChannel(this, topic);
  }

  async removeChannel(channel: DemoChannel) {
    this.channels.delete(channel);
    return "ok";
  }

  readonly storage = {
    from: (bucket: string) => ({
      upload: async (key: string, file: Blob, options: { contentType?: string; upsert?: boolean } = {}) => {
        try {
          await uploadObject(await this.database(), this.actor(), bucket, key, file, options.contentType);
          return ok({ path: key });
        } catch (error) {
          return fail(error);
        }
      },
      download: async (key: string) => {
        try {
          const database = await this.database();
          const { rows } = await database.as(this.actor(), (tx) =>
            tx.query<{ source: string | null }>(
              "select metadata->>'demo_source' as source from storage.objects where bucket_id = $1 and name = $2", [bucket, key]));
          const [row] = rows;
          let blob: Blob | undefined;
          if (row?.source) {
            const response = await fetch(row.source);
            if (response.ok) blob = await response.blob();
          } else if (row) {
            blob = await media.get(`${bucket}/${key}`);
          }
          return blob ? ok(blob) : fail({ message: "Object not found", code: "404" });
        } catch (error) {
          return fail(error);
        }
      },
      remove: async (keys: string[]) => {
        try {
          const database = await this.database();
          const { rows } = await database.as(this.actor(), (tx) =>
            tx.query<{ name: string }>("delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name", [bucket, keys]));
          for (const row of rows) await media.delete(`${bucket}/${row.name}`);
          return ok(rows);
        } catch (error) {
          return fail(error);
        }
      },
    }),
  };
}

/** Stores an object the way Supabase Storage does: the row passes RLS, then the bytes are kept. */
async function uploadObject(database: DemoDatabase, actor: Actor, bucket: string, key: string, file: Blob, contentType = file.type) {
  await database.as(actor, (tx) => tx.query(
    "insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5)",
    [bucket, key, actor.id, actor.id, { mimetype: contentType, size: file.size }],
  ));
  await media.put(`${bucket}/${key}`, file);
}

/**
 * Registers a bundled sample photo as an uploaded object. Its bytes stay in
 * /public and are fetched on download, so seeded media cannot go missing.
 */
export async function registerSampleObject(database: DemoDatabase, actor: Actor, bucket: string, key: string, source: string, size: number) {
  await database.as(actor, (tx) => tx.query(
    "insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5)",
    [bucket, key, actor.id, actor.id, { mimetype: "image/jpeg", size, demo_source: source }],
  ));
}

export type { DemoDatabase, Actor };

let client: DemoClient | undefined;

/** The demo client, typed as the Supabase client the components expect. */
export function getDemoClient(): SupabaseClient {
  client ??= new DemoClient();
  return client as unknown as SupabaseClient;
}

export function switchDemoPersona(id: string) {
  client?.switchPersona(id);
}

/** Deletes all demo data and reloads the page with a freshly seeded database. */
export async function resetDemo() {
  storageSet(USER_KEY, null);
  storageSet(`${USER_KEY}:email`, null);
  await client?.close();
  await media.clear().catch(() => undefined);
  await deleteDatabases(() => true);
  window.location.reload();
}
