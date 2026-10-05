import { AdapterError, type Adapter, type FetchContext } from "../../types.ts";
import { cookieHeader } from "../../text.ts";

// Microsoft careers (Eightfold PCSX). robots.txt explicitly allows /careers and /api/pcsx.
// The API answers 429 without the session cookies the careers page sets, so load it first.
//   GET https://apply.careers.microsoft.com/careers?domain=microsoft.com
//   GET https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query={term}&location=&start=N&sort_by=timestamp

export type MicrosoftPosition = {
  id: number;
  name: string;
  positionUrl: string;
  postedTs?: number; // seconds
  standardizedLocations?: string[];
  locations?: string[];
  workLocationOption?: string;
};

const ORIGIN = "https://apply.careers.microsoft.com";
const PAGE = 10;
const MAX_PAGES = 15;
const TERMS = ["intern", "co-op"];

async function session(ctx: FetchContext): Promise<string> {
  const res = await ctx.fetch(`${ORIGIN}/careers?domain=microsoft.com`, { signal: ctx.signal, headers: { Accept: "text/html" } });
  await res.body?.cancel();
  if (!res.ok) throw new AdapterError(`microsoft session ${res.status}`, "custom", res.status);
  return cookieHeader(res);
}

export const microsoft: Adapter<MicrosoftPosition> = {
  ats: "custom",
  async fetchList(_src, ctx) {
    const cookie = await session(ctx);
    const seen = new Map<number, MicrosoftPosition>();
    for (const term of TERMS) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${ORIGIN}/api/pcsx/search?domain=microsoft.com&query=${encodeURIComponent(term)}&location=&start=${page * PAGE}&sort_by=timestamp`;
        const res = await ctx.fetch(url, {
          signal: ctx.signal,
          headers: { Cookie: cookie, Referer: `${ORIGIN}/careers?domain=microsoft.com` },
        });
        if (!res.ok) throw new AdapterError(`microsoft ${res.status}`, "custom", res.status);
        const data = ((await res.json()) as { data?: { positions?: MicrosoftPosition[]; count?: number } }).data;
        const positions = data?.positions ?? [];
        for (const p of positions) seen.set(p.id, p);
        if (positions.length < PAGE || (page + 1) * PAGE >= (data?.count ?? 0)) break;
      }
    }
    return [...seen.values()];
  },
  normalize(_src, p) {
    const location = (p.standardizedLocations?.length ? p.standardizedLocations : p.locations)?.join("; ") || null;
    return {
      externalId: String(p.id),
      title: p.name.replace(/[\s,]+$/, "").trim(),
      url: `${ORIGIN}${p.positionUrl}`,
      location,
      remote: p.workLocationOption ? p.workLocationOption === "remote" : null,
      sourcePostedAt: p.postedTs ? p.postedTs * 1000 : null,
      descriptionText: null,
    };
  },
};
