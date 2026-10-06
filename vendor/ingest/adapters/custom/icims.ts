import { AdapterError, type Adapter } from "../../types.ts";
import { extractAnchors, jsonLdJobPosting, toEpochMs } from "../../text.ts";

// iCIMS career portals: server-rendered keyword search; detail pages carry JSON-LD JobPosting.
//   GET https://{host}/jobs/search?ss=1&searchKeyword={term}&in_iframe=1&pr={page}
// robots.txt disallows only referral/login/candidate paths.

export type IcimsJob = {
  id: string;
  title: string;
  url: string;
  postedAt?: number | null;
  location?: string | null;
  category?: string | null;
  remote?: boolean | null;
};

const TERMS = ["co-op", "intern"];
const MAX_PAGES = 5;
const JOB_HREF = /\/jobs\/\d+\/[^/]+\/job/;

function host(careersUrl: string | null | undefined, boardToken: string) {
  return new URL(careersUrl ?? boardToken).host;
}

/** Portal-local "M/D/YYYY h:mm AM" (iCIMS shows US Eastern for the portals we track) → epoch ms. */
export function parseIcimsDate(s: string): number | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?$/i);
  if (!m) return null;
  let h = m[4] ? Number(m[4]) % 12 : 12;
  if (m[6]?.toUpperCase() === "PM") h += 12;
  const asUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, m[5] ? Number(m[5]) : 0);
  // Eastern offset at that instant (handles DST) via Intl.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23", day: "numeric" }).formatToParts(asUtc);
  const localH = Number(parts.find((p) => p.type === "hour")?.value);
  const localD = Number(parts.find((p) => p.type === "day")?.value);
  let offset = localH - new Date(asUtc).getUTCHours();
  if (localD !== new Date(asUtc).getUTCDate()) offset -= 24;
  return asUtc - offset * 3_600_000;
}

/** Card fields: "<dt>Posted Date</dt><dd><span title="9/24/2026 2:48 PM">". */
function cardField(card: string, label: string): { text: string; title: string | null } | null {
  const i = card.indexOf(`>${label}</dt>`);
  if (i < 0) return null;
  const chunk = card.slice(i, i + 600);
  const m = chunk.match(/<dd[^<>]{0,200}>\s{0,20}<span([^<>]{0,300})>([^<]{0,300})/i);
  if (!m) return null;
  return { text: m[2].trim(), title: m[1].match(/title="([^"]{1,60})"/)?.[1] ?? null };
}

function cardLocation(card: string): string | null {
  const i = card.indexOf(">Location</span>");
  if (i < 0) return null;
  return card.slice(i + 16, i + 400).match(/<span[^<>]{0,100}>([^<]{1,200})</)?.[1].trim() ?? null;
}

export function parseIcimsSearch(html: string, baseUrl: string): IcimsJob[] {
  const jobs = new Map<string, IcimsJob>();
  // Card layout (most portals): read posted date, category, location and remote from each card.
  const cards = html.split(/<li class="iCIMS_JobCardItem"/i).slice(1, 200);
  const cardById = new Map<string, string>();
  for (const raw of cards) {
    const card = raw.slice(0, 12_000);
    const id = card.match(/\/jobs\/(\d+)\/[^/"]+\/job/)?.[1];
    if (id) cardById.set(id, card);
  }
  const host = new URL(baseUrl).host;
  for (const a of extractAnchors(html, JOB_HREF, baseUrl)) {
    if (new URL(a.href).host !== host) continue; // same-site job links only
    const id = a.href.match(/\/jobs\/(\d+)\//)?.[1];
    const title = a.text.replace(/^Title\s+/i, "").trim();
    if (!id || !title || jobs.has(id)) continue;
    const u = new URL(a.href);
    u.search = ""; // drop in_iframe for the public link
    const card = cardById.get(id);
    const posted = card ? cardField(card, "Posted Date") : null;
    const remote = card ? cardField(card, "Remote")?.text : undefined;
    jobs.set(id, {
      id,
      title,
      url: u.toString(),
      postedAt: posted?.title ? parseIcimsDate(posted.title) : null,
      location: card ? cardLocation(card) : null,
      category: card ? (cardField(card, "Category")?.text ?? null) : null,
      remote: remote ? /^yes$/i.test(remote) : null,
    });
  }
  return [...jobs.values()];
}

export const icims: Adapter<IcimsJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const h = host(src.careersUrl, src.boardToken);
    const seen = new Map<string, IcimsJob>();
    for (const term of TERMS) {
      for (let pr = 0; pr < MAX_PAGES; pr++) {
        const url = `https://${h}/jobs/search?ss=1&searchKeyword=${encodeURIComponent(term)}&in_iframe=1&pr=${pr}`;
        const res = await ctx.fetch(url, { signal: ctx.signal, headers: { Accept: "text/html" } });
        if (!res.ok) throw new AdapterError(`icims ${res.status} ${h}`, "custom", res.status);
        const jobs = parseIcimsSearch(await res.text(), url);
        const before = seen.size;
        for (const j of jobs) seen.set(j.id, j);
        if (!jobs.length || seen.size === before) break; // no new results: last page
      }
    }
    return [...seen.values()];
  },
  normalize(_src, j) {
    return {
      externalId: j.id,
      title: j.title,
      url: j.url,
      location: j.location ?? null,
      remote: j.remote ?? null,
      sourcePostedAt: j.postedAt ?? null,
      descriptionText: null,
      department: j.category ?? null,
    };
  },
  async fetchDetail(_src, posting, ctx) {
    const res = await ctx.fetch(`${posting.url}?in_iframe=1`, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`icims detail ${res.status}`, "custom", res.status);
    const ld = jsonLdJobPosting(await res.text());
    return {
      descriptionText: ld?.description ?? null,
      // The list card has the posted minute; JSON-LD is day-only, so it's a fallback.
      sourcePostedAt: posting.sourcePostedAt ?? toEpochMs(ld?.datePosted?.slice(0, 10) ?? null),
      location: posting.location ?? ld?.location ?? null,
      ...(ld?.remote ? { remote: true } : {}),
    };
  },
};
