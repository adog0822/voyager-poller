import { AdapterError, type Adapter } from "../types.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// List:   GET https://{slug}.bamboohr.com/careers/list        (no dates)
// Detail: GET https://{slug}.bamboohr.com/careers/{id}/detail (datePosted, description)
// Unknown slugs 302 to bamboohr.com: detected as a non-JSON response.

export type BambooJob = {
  id: string;
  jobOpeningName: string;
  location?: { city?: string | null; state?: string | null };
  isRemote?: boolean | null;
  locationType?: string | null;
};

const origin = (slug: string) => `https://${slug}.bamboohr.com`;

export const bamboohr: Adapter<BambooJob> = {
  ats: "bamboohr",

  async fetchList(src, ctx) {
    const slug = src.config.slug ?? src.boardToken;
    const res = await ctx.fetch(`${origin(slug)}/careers/list`, { signal: ctx.signal });
    if (!res.ok || !res.headers.get("content-type")?.includes("json") || new URL(res.url || origin(slug)).host !== `${slug}.bamboohr.com`) {
      throw new AdapterError(`bamboohr ${res.status} ${src.boardToken}`, "bamboohr", res.status);
    }
    return ((await res.json()) as { result?: BambooJob[] }).result ?? [];
  },

  normalize(src, j) {
    const slug = src.config.slug ?? src.boardToken;
    const location = [j.location?.city, j.location?.state].filter(Boolean).join(", ") || null;
    return {
      externalId: String(j.id),
      title: j.jobOpeningName.trim(),
      url: `${origin(slug)}/careers/${j.id}`,
      location,
      // locationType "1" = remote, "2" = hybrid, "0" = on-site
      remote: j.isRemote ?? (j.locationType === "1" ? true : j.locationType ? false : null),
      sourcePostedAt: null,
      descriptionText: null,
    };
  },

  async fetchDetail(src, posting, ctx) {
    const slug = src.config.slug ?? src.boardToken;
    const res = await ctx.fetch(`${origin(slug)}/careers/${posting.externalId}/detail`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`bamboohr detail ${res.status}`, "bamboohr", res.status);
    const jo = ((await res.json()) as { result?: { jobOpening?: { datePosted?: string; description?: string } } }).result
      ?.jobOpening;
    return { sourcePostedAt: toEpochMs(jo?.datePosted ?? null), descriptionText: htmlToText(jo?.description) };
  },
};
