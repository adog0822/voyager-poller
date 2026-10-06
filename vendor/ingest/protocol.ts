// Wire format between the Actions poller and the Worker (/api/poll-plan, /api/ingest).
import { z } from "zod";
import { Details } from "./details.ts";
import { NormalizedPosting } from "./types.ts";

export const TIERS = ["hot", "warm", "cold"] as const;
export type Tier = (typeof TIERS)[number];

export const PlanSource = z.object({
  id: z.number().int(),
  ats: z.string(),
  boardToken: z.string(),
  config: z.record(z.string(), z.string()),
  careersUrl: z.string().nullable().optional(),
});
export type PlanSource = z.infer<typeof PlanSource>;

/** An existing open co-op that still lacks details or a posted date (backfill rows, failed detail calls). */
export const EnrichTask = z.object({
  postingId: z.number().int(),
  source: PlanSource,
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  location: z.string().nullable(),
  sourcePostedAt: z.number().int().nullable(),
});
export type EnrichTask = z.infer<typeof EnrichTask>;

export const PollPlan = z.object({ runId: z.string(), sources: z.array(PlanSource), enrich: z.array(EnrichTask).max(500).default([]) });
export type PollPlan = z.infer<typeof PollPlan>;

/** Descriptions are only for classification at ingest; trimmed and never stored in full. */
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_POSTINGS_PER_REQUEST = 50;

export const IngestSource = z.object({
  sourceId: z.number().int(),
  postings: z.array(NormalizedPosting).max(MAX_POSTINGS_PER_REQUEST),
  /** Present only on a source's final chunk: every live candidate id, for closing removed postings. */
  fullIdList: z.array(z.string()).optional(),
});
export const IngestBody = z.object({
  runId: z.string(),
  sources: z.array(IngestSource).min(1),
});
export type IngestBody = z.infer<typeof IngestBody>;

export const MAX_ENRICHED_PER_REQUEST = 100;

/** Result of an enrichment task. `details: null` = the detail call failed (counts as an attempt). */
export const Enriched = z.object({
  postingId: z.number().int(),
  sourcePostedAt: z.number().int().positive().nullable(),
  location: z.string().max(300).nullable(),
  details: Details.nullable(),
});
export type Enriched = z.infer<typeof Enriched>;
export const EnrichedBody = z.object({ runId: z.string(), items: z.array(Enriched).min(1).max(MAX_ENRICHED_PER_REQUEST) });
export type EnrichedBody = z.infer<typeof EnrichedBody>;

export const RunSummary = z.object({
  runId: z.string(),
  tiers: z.array(z.enum(TIERS)),
  startedAt: z.number().int(),
  finishedAt: z.number().int(),
  sourcesPolled: z.number().int(),
  sourcesChanged: z.number().int(),
  okSourceIds: z.array(z.number().int()),
  failures: z.array(
    z.object({ sourceId: z.number().int(), error: z.string().max(300), robotsDisallowed: z.boolean() }),
  ),
});
export type RunSummary = z.infer<typeof RunSummary>;
