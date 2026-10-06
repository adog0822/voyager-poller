// One poller run: fetch the plan, poll each due source politely, send only changes.
//
//   INGEST_URL=https://<worker> INGEST_HMAC_KEY=... TIERS=hot,warm node src/run.ts
//
// State (state/state.json, persisted with actions/cache) keeps a hash + id list per
// source. Unchanged sources send nothing; only new postings get a detail call.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPoliteFetch,
  enrich,
  extractDetails,
  listCandidates,
  MAX_ENRICHED_PER_REQUEST,
  MAX_DESCRIPTION_CHARS,
  MAX_POSTINGS_PER_REQUEST,
  PollPlan,
  RobotsDisallowedError,
  sha256Hex,
  signRequest,
  type Enriched,
  type IngestBody,
  type NormalizedPosting,
  type PlanSource,
  type RunSummary,
  type SourceConfig,
  type Tier,
} from "../vendor/ingest/index.ts";

const INGEST_URL = must("INGEST_URL").replace(/\/$/, "");
const KEY = must("INGEST_HMAC_KEY");
const TIERS = (process.env.TIERS || "hot").split(",").map((t) => t.trim()) as Tier[];
const STATE_FILE = process.env.STATE_FILE || "state/state.json";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const ENRICH_BUDGET = Number(process.env.ENRICH_BUDGET || 400); // detail calls per run
const SOURCE_TIMEOUT_MS = 120_000;
const MAX_SOURCES_PER_REQUEST = 100;
const MAX_REQUEST_BYTES = 800_000; // Worker refuses bodies over 1 MB

type SourceState = { hash: string; ids: string[] };
type State = { v: 1; sources: Record<string, SourceState> };

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (s.v === 1 && s.sources) return s;
  } catch {}
  return { v: 1, sources: {} };
}

async function signedFetch(method: "GET" | "POST", path: string, body?: unknown) {
  const url = `${INGEST_URL}${path}`;
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers = { ...(await signRequest(KEY, method, url, text)), "Content-Type": "application/json", "User-Agent": "voyager-poller" };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : text });
    if (res.ok) return res.json();
    if (attempt < 2 && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

type Changed = { src: PlanSource; postings: NormalizedPosting[]; next: SourceState };

async function main() {
  const startedAt = Date.now();
  const state = loadState();
  const plan = PollPlan.parse(await signedFetch("GET", `/api/poll-plan?tiers=${TIERS.join(",")}`));
  console.log(`run ${plan.runId}: ${plan.sources.length} sources (tiers=${TIERS.join(",")})`);

  const fetch = createPoliteFetch({ userAgent: "VoyagerBot/1.0 (+https://github.com/adog0822/voyager-poller)" });
  const changed: Changed[] = [];
  const okSourceIds: number[] = [];
  const failures: RunSummary["failures"] = [];
  let enrichLeft = ENRICH_BUDGET;
  let listed = 0;

  await pool(plan.sources, CONCURRENCY, async (src) => {
    const cfg: SourceConfig = {
      id: src.id,
      ats: src.ats as SourceConfig["ats"],
      boardToken: src.boardToken,
      config: src.config,
      careersUrl: src.careersUrl ?? null,
    };
    const signal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
    try {
      const r = await listCandidates(cfg, { fetch, signal });
      listed += r.totalListed;
      okSourceIds.push(src.id);
      const sorted = [...r.candidates].sort((a, b) => a.externalId.localeCompare(b.externalId));
      const hash = await sha256Hex(JSON.stringify(sorted.map((p) => [p.externalId, p.title, p.url, p.location])));
      const prev = state.sources[src.id];
      if (prev?.hash === hash) return;

      // Detail calls only for postings new since the last run (none on a source's first run: that's backfill).
      const known = new Set(prev?.ids ?? []);
      const postings: NormalizedPosting[] = [];
      for (const p of sorted) {
        let out = p;
        if (prev && !known.has(p.externalId) && enrichLeft > 0) {
          enrichLeft--;
          out = await enrich(cfg, p, { fetch, signal }).catch(() => p);
        }
        // Facts are extracted here (no CPU limit), from the full description; only the facts travel.
        const details = extractDetails({ title: out.title, description: out.descriptionText, department: out.department, structuredPay: out.pay });
        postings.push({ ...out, details, descriptionText: out.descriptionText?.slice(0, MAX_DESCRIPTION_CHARS) ?? null });
      }
      changed.push({ src, postings, next: { hash, ids: sorted.map((p) => p.externalId) } });
    } catch (err) {
      const robots = err instanceof RobotsDisallowedError;
      failures.push({ sourceId: src.id, error: String((err as Error).message ?? err).slice(0, 300), robotsDisallowed: robots });
    }
  });

  // Enrichment: existing open co-ops still missing a date or details (backfill rows, earlier
  // failures). Whatever detail budget the new postings left over goes here.
  const enrichedItems: Enriched[] = [];
  await pool(plan.enrich.slice(0, Math.max(0, enrichLeft)), Math.min(CONCURRENCY, 8), async (t) => {
    enrichLeft--;
    const cfg: SourceConfig = {
      id: t.source.id,
      ats: t.source.ats as SourceConfig["ats"],
      boardToken: t.source.boardToken,
      config: t.source.config,
      careersUrl: t.source.careersUrl ?? null,
    };
    const base: NormalizedPosting = { externalId: t.externalId, title: t.title, url: t.url, location: t.location, remote: null, sourcePostedAt: t.sourcePostedAt, descriptionText: null };
    try {
      const out = await enrich(cfg, base, { fetch, signal: AbortSignal.timeout(30_000) });
      const details = extractDetails({ title: out.title, description: out.descriptionText, department: out.department, structuredPay: out.pay });
      enrichedItems.push({ postingId: t.postingId, sourcePostedAt: out.sourcePostedAt, location: out.location, details });
    } catch {
      enrichedItems.push({ postingId: t.postingId, sourcePostedAt: null, location: null, details: null });
    }
  });
  let enrichedSent = 0;
  for (let i = 0; i < enrichedItems.length; i += MAX_ENRICHED_PER_REQUEST) {
    const items = enrichedItems.slice(i, i + MAX_ENRICHED_PER_REQUEST);
    try {
      await signedFetch("POST", "/api/ingest/enriched", { runId: plan.runId, items });
      enrichedSent += items.length;
    } catch (err) {
      console.error(`enriched request failed (${String((err as Error).message).match(/-> (\d{3})/)?.[1] ?? "network"})`);
    }
  }

  // Pack changed sources into requests of <= 50 postings / <= 100 sources.
  // A source with > 50 candidates is split; only its final chunk carries fullIdList.
  const requests: IngestBody["sources"][] = [];
  let cur: IngestBody["sources"] = [];
  let curPostings = 0;
  let curBytes = 0;
  const flush = () => {
    if (cur.length) requests.push(cur);
    cur = [];
    curPostings = 0;
    curBytes = 0;
  };
  for (const c of changed) {
    const chunks: NormalizedPosting[][] = [];
    for (let i = 0; i < c.postings.length; i += MAX_POSTINGS_PER_REQUEST) chunks.push(c.postings.slice(i, i + MAX_POSTINGS_PER_REQUEST));
    if (!chunks.length) chunks.push([]);
    chunks.forEach((chunk, i) => {
      const entry = { sourceId: c.src.id, postings: chunk, ...(i === chunks.length - 1 ? { fullIdList: c.next.ids } : {}) };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (curPostings + chunk.length > MAX_POSTINGS_PER_REQUEST || cur.length >= MAX_SOURCES_PER_REQUEST || curBytes + size > MAX_REQUEST_BYTES) flush();
      cur.push(entry);
      curPostings += chunk.length;
      curBytes += size;
    });
  }
  flush();

  // Commit state only for sources the Worker accepted (not deferred, request succeeded).
  const nextBySource = new Map(changed.map((c) => [c.src.id, c.next]));
  const failedSend = new Set<number>();
  const deferred = new Set<number>();
  let inserted = 0;
  for (const sources of requests) {
    try {
      const res = (await signedFetch("POST", "/api/ingest", { runId: plan.runId, sources })) as {
        inserted: number;
        deferredSourceIds: number[];
      };
      inserted += res.inserted;
      res.deferredSourceIds.forEach((id) => deferred.add(id));
    } catch (err) {
      console.error(`ingest request failed (${String((err as Error).message).match(/-> (\d{3})/)?.[1] ?? "network"})`);
      sources.forEach((s) => failedSend.add(s.sourceId));
    }
  }
  for (const [id, next] of nextBySource) {
    if (!failedSend.has(id) && !deferred.has(id)) state.sources[id] = next;
  }

  const summary: RunSummary = {
    runId: plan.runId,
    tiers: TIERS,
    startedAt,
    finishedAt: Date.now(),
    sourcesPolled: plan.sources.length,
    sourcesChanged: changed.length,
    okSourceIds,
    failures,
  };
  await signedFetch("POST", "/api/ingest/run-summary", summary);

  mkdirSync(STATE_FILE.replace(/\/[^/]*$/, ""), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));

  const robots = failures.filter((f) => f.robotsDisallowed).length;
  console.log(
    [
      `polled=${plan.sources.length} ok=${okSourceIds.length} failed=${failures.length} (robots=${robots})`,
      `listed=${listed} changed=${changed.length} requests=${requests.length} inserted=${inserted}`,
      `deferred=${deferred.size} sendFailures=${failedSend.size} enrichUsed=${ENRICH_BUDGET - enrichLeft} enrichedSent=${enrichedSent}/${plan.enrich.length}`,
      `took=${Math.round((Date.now() - startedAt) / 1000)}s`,
    ].join("\n"),
  );
  // This repo's Actions logs are public: summarize failure kinds only (details go to the
  // Worker's run summary, which is private).
  const kinds = failures.reduce<Record<string, number>>((m, f) => {
    const k = f.robotsDisallowed ? "robots" : (f.error.match(/\b(\d{3})\b/)?.[1] ?? f.error.split(/[\s:]/)[0]);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  if (failures.length) console.log(`failure kinds: ${JSON.stringify(kinds)}`);
}

main().catch((err) => {
  // Message only: a full error (with cause) could print the private ingest hostname.
  console.error(`poller failed: ${(err as Error).name}: ${String((err as Error).message).replace(/https?:\/\/[^\s/]+/g, "<host>")}`);
  process.exit(1);
});
