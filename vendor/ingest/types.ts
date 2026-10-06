import { z } from "zod";
import type { ApiAts } from "./fingerprint.ts";
import type { PoliteFetch } from "./http.ts";

/** A pollable source, as stored in D1 `sources` (subset the adapters need). */
export type SourceConfig = {
  id?: number;
  ats: ApiAts | "custom";
  boardToken: string;
  config: Record<string, string>;
  careersUrl?: string | null;
};

// Untrusted career-site content: http(s) URLs only (no javascript:/data:/file:) and
// bounded field sizes, so one hostile board can't bloat requests, rows or queue messages.
export const NormalizedPosting = z.object({
  externalId: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  location: z.string().max(300).nullable(),
  remote: z.boolean().nullable(),
  /** Epoch ms from the source, or null if the source doesn't expose one (then `first_seen_at` is the truth). */
  sourcePostedAt: z.number().int().positive().nullable(),
  /** Plain text, only when the list or detail call provided it. */
  descriptionText: z.string().max(20_000).nullable().optional(),
});
export type NormalizedPosting = z.infer<typeof NormalizedPosting>;

export type FetchContext = {
  fetch: PoliteFetch;
  signal?: AbortSignal;
  /** Injectable clock for relative dates (Workday "Posted 3 Days Ago"). */
  now?: () => number;
};

export interface Adapter<Raw = unknown> {
  ats: ApiAts | "custom";
  /** Cheap list call(s). May pre-narrow server-side (Workday/Oracle keyword search). */
  fetchList(src: SourceConfig, ctx: FetchContext): Promise<Raw[]>;
  normalize(src: SourceConfig, raw: Raw, ctx: FetchContext): NormalizedPosting;
  /** Extra call for description/date. Poller calls it only for NEW candidate postings. */
  fetchDetail?(src: SourceConfig, posting: NormalizedPosting, ctx: FetchContext): Promise<Partial<NormalizedPosting>>;
}

// No parameter properties: this package must run under Node's strip-only TS.
export class AdapterError extends Error {
  readonly ats: string;
  readonly status?: number;
  constructor(message: string, ats: string, status?: number) {
    super(message);
    this.name = "AdapterError";
    this.ats = ats;
    this.status = status;
  }
}
