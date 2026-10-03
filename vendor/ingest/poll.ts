import { adapters } from "./adapters/index.ts";
import { prefilter } from "./coop.ts";
import { NormalizedPosting, type FetchContext, type SourceConfig } from "./types.ts";

export type CandidateResult = {
  /** Student-role postings (co-op/intern/...), normalized and validated. */
  candidates: NormalizedPosting[];
  /** Every posting the list call returned, before the prefilter. */
  totalListed: number;
  /** Postings dropped because they failed validation (bad URL, empty title...). */
  invalid: number;
};

/**
 * Cheap pass for one source: list call(s) → normalize → validate → prefilter.
 * Never calls detail endpoints; the poller enriches only postings it hasn't seen.
 */
export async function listCandidates(src: SourceConfig, ctx: FetchContext): Promise<CandidateResult> {
  const adapter = adapters[src.ats];
  if (!adapter) throw new Error(`no adapter for ${src.ats}`);
  const raws = await adapter.fetchList(src, ctx);
  const byId = new Map<string, NormalizedPosting>();
  let invalid = 0;
  for (const raw of raws) {
    let parsed;
    try {
      parsed = NormalizedPosting.safeParse(adapter.normalize(src, raw, ctx));
    } catch {
      invalid++;
      continue;
    }
    if (!parsed.success) {
      invalid++;
      continue;
    }
    if (prefilter(parsed.data.title)) byId.set(parsed.data.externalId, parsed.data);
  }
  return { candidates: [...byId.values()], totalListed: raws.length, invalid };
}

/** Detail call for a NEW candidate (description, precise date). No-op if the list had it all. */
export async function enrich(src: SourceConfig, posting: NormalizedPosting, ctx: FetchContext): Promise<NormalizedPosting> {
  const adapter = adapters[src.ats];
  if (!adapter.fetchDetail) return posting;
  const extra = await adapter.fetchDetail(src, posting, ctx);
  const merged = { ...posting, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null)) };
  return NormalizedPosting.parse(merged);
}
