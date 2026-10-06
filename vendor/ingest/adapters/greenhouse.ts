import { AdapterError, type Adapter } from "../types.ts";
import { guessUnit, unitFrom, type Pay } from "../details.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs           (list, no content)
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}      (detail with content)
// `first_published` is the real post date; `updated_at` changes on every edit.

export type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  first_published?: string | null;
  updated_at?: string;
  pay_input_ranges?: GreenhousePay[];
};

type GreenhousePay = { min_cents?: number; max_cents?: number; currency_type?: string; title?: string; blurb?: string };

/** `?pay_transparency=true` adds pay ranges. They carry no unit: read it from the label, else magnitude. */
export function greenhousePay(ranges: GreenhousePay[] | undefined): Pay | null {
  const r = ranges?.find((x) => x.min_cents && x.min_cents > 0);
  if (!r?.min_cents) return null;
  const min = r.min_cents / 100;
  const max = (r.max_cents ?? r.min_cents) / 100;
  const unit = unitFrom(`${r.title ?? ""} ${(r.blurb ?? "").slice(0, 200)}`) ?? guessUnit(min);
  return { min, max: Math.max(min, max), unit, currency: (r.currency_type ?? "USD").slice(0, 3).toUpperCase(), source: "ats" };
}

const JUNK_META = /function|job family|category|department|discipline/i;

const API = "https://boards-api.greenhouse.io/v1/boards";

export const greenhouse: Adapter<GreenhouseJob> = {
  ats: "greenhouse",

  async fetchList(src, ctx) {
    const res = await ctx.fetch(`${API}/${src.boardToken}/jobs?pay_transparency=true`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`greenhouse ${res.status} ${src.boardToken}`, "greenhouse", res.status);
    return ((await res.json()) as { jobs?: GreenhouseJob[] }).jobs ?? [];
  },

  normalize(_src, j) {
    const loc = j.location?.name?.trim() || null;
    return {
      externalId: String(j.id),
      title: j.title.trim(),
      url: j.absolute_url,
      location: loc,
      remote: loc ? /remote/i.test(loc) : null,
      sourcePostedAt: toEpochMs(j.first_published ?? null),
      descriptionText: null,
      pay: greenhousePay(j.pay_input_ranges),
    };
  },

  async fetchDetail(src, posting, ctx) {
    const res = await ctx.fetch(`${API}/${src.boardToken}/jobs/${posting.externalId}?pay_transparency=true`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`greenhouse detail ${res.status}`, "greenhouse", res.status);
    const d = (await res.json()) as {
      content?: string;
      departments?: { name?: string }[];
      metadata?: { name?: string; value?: unknown }[] | null;
      pay_input_ranges?: GreenhousePay[];
    };
    const meta = d.metadata?.find((m) => m.name && JUNK_META.test(m.name) && typeof m.value === "string" && m.value)?.value as string | undefined;
    return {
      descriptionText: htmlToText(d.content),
      department: meta ?? d.departments?.find((x) => x.name)?.name ?? null,
      pay: greenhousePay(d.pay_input_ranges) ?? posting.pay ?? null,
    };
  },
};
