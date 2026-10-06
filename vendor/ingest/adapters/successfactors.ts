import { AdapterError, type Adapter } from "../types.ts";
import { decodeEntities, htmlToText } from "../text.ts";

// SAP SuccessFactors Recruiting Marketing career sites (company domains).
//   GET https://{host}/sitemap.xml  → RSS 2.0 feed of every live job, with descriptions.
//   Some sites serve a standard <urlset> there and the RSS feed at /sitemal.xml instead.
// The /services/rss/job/ feed is robots-disallowed on these sites, so we use the sitemaps.
// Items carry no publish date; the detail page has <meta itemprop="datePosted">.

export type SfItem = { id: string; title: string; link: string; location: string | null; description: string | null };

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^<>]*)?>([\\s\\S]{0,65536}?)</${name}>`));
  if (!m) return null;
  const v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : decodeEntities(v);
}

/** "Fri Sep 25 02:00:00 UTC 2026" (Java Date.toString) or ISO → epoch ms. */
export function parseSfDate(s: string | null): number | null {
  if (!s) return null;
  const j = s.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (?:UTC|GMT) (\d{4})$/);
  if (j) {
    const t = Date.parse(`${j[1]} ${j[2]}, ${j[6]} ${j[3]}:${j[4]}:${j[5]} UTC`);
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function parseSfSitemap(xml: string): SfItem[] {
  const items: SfItem[] = [];
  // indexOf split (a regex span over an unclosed <item> would be quadratic); items capped at 64 KB.
  let from = 0;
  for (;;) {
    const start = xml.indexOf("<item>", from);
    if (start < 0) break;
    const end = xml.indexOf("</item>", start);
    if (end < 0) break;
    from = end + 7;
    const it = xml.slice(start + 6, Math.min(end, start + 6 + 65_536));
    const link = tag(it, "link");
    const id = tag(it, "g:id") ?? tag(it, "guid") ?? link;
    const title = tag(it, "title");
    if (!id || !title || !link) continue;
    items.push({ id, title, link, location: tag(it, "g:location"), description: tag(it, "description") });
  }
  return items;
}

/** Titles embed the location: "Engineer (Louisville, KY, US, 40258)". Strip it. */
function cleanTitle(title: string, location: string | null): string {
  if (location && title.endsWith(`(${location})`)) return title.slice(0, -(location.length + 2)).trim();
  return title.trim();
}

export const successfactors: Adapter<SfItem> = {
  ats: "successfactors",

  async fetchList(src, ctx) {
    const host = src.config.host ?? src.boardToken;
    for (const path of ["/sitemap.xml", "/sitemal.xml"]) {
      const res = await ctx.fetch(`https://${host}${path}`, { signal: ctx.signal, headers: { Accept: "application/xml, text/xml" } });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      const xml = await res.text();
      if (xml.includes("<rss")) return parseSfSitemap(xml);
    }
    throw new AdapterError(`successfactors: no RSS job feed at /sitemap.xml or /sitemal.xml (${host})`, "successfactors");
  },

  normalize(_src, it) {
    return {
      externalId: it.id,
      title: cleanTitle(it.title, it.location),
      url: it.link,
      location: it.location,
      remote: it.location ? /remote/i.test(it.location) : null,
      sourcePostedAt: null,
      descriptionText: htmlToText(it.description),
    };
  },

  async fetchDetail(_src, posting, ctx) {
    const res = await ctx.fetch(posting.url, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`successfactors detail ${res.status}`, "successfactors", res.status);
    const html = (await res.text()).slice(0, 400_000);
    const m = html.match(/itemprop="datePosted"[^<>]{0,40}content="([^"]{6,60})"|content="([^"]{6,60})"[^<>]{0,40}itemprop="datePosted"/);
    return { sourcePostedAt: parseSfDate(m?.[1] ?? m?.[2] ?? null) };
  },
};
