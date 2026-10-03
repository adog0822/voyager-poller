import { AdapterError, type Adapter } from "../types.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// List:   GET https://ats.rippling.com/api/v2/board/{slug}/jobs?page=N&pageSize=50  (no dates)
// Detail: GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid} (createdOn, description)

export type RipplingJob = {
  id: string;
  name: string;
  url: string;
  locations?: { name?: string; workplaceType?: string }[];
};

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export const rippling: Adapter<RipplingJob> = {
  ats: "rippling",

  async fetchList(src, ctx) {
    const slug = src.config.slug ?? src.boardToken;
    const out: RipplingJob[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await ctx.fetch(
        `https://ats.rippling.com/api/v2/board/${encodeURIComponent(slug)}/jobs?page=${page}&pageSize=${PAGE_SIZE}`,
        { signal: ctx.signal },
      );
      if (!res.ok) throw new AdapterError(`rippling ${res.status} ${src.boardToken}`, "rippling", res.status);
      const body = (await res.json()) as { items?: RipplingJob[]; totalPages?: number };
      out.push(...(body.items ?? []));
      if (page + 1 >= (body.totalPages ?? 1)) break;
    }
    return out;
  },

  normalize(_src, j) {
    const locs = j.locations ?? [];
    return {
      externalId: j.id,
      title: j.name.trim(),
      url: j.url,
      location: locs.map((l) => l.name).filter(Boolean).join("; ") || null,
      remote: locs.length ? locs.some((l) => l.workplaceType === "REMOTE") : null,
      sourcePostedAt: null,
      descriptionText: null,
    };
  },

  async fetchDetail(src, posting, ctx) {
    const slug = src.config.slug ?? src.boardToken;
    const res = await ctx.fetch(
      `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs/${posting.externalId}`,
      { signal: ctx.signal },
    );
    if (!res.ok) throw new AdapterError(`rippling detail ${res.status}`, "rippling", res.status);
    const d = (await res.json()) as { createdOn?: string; description?: { company?: string; role?: string } };
    return {
      sourcePostedAt: toEpochMs(d.createdOn ?? null),
      descriptionText: htmlToText(d.description?.role) ?? htmlToText(d.description?.company),
    };
  },
};
