import { AdapterError, type Adapter } from "../types.ts";
import { decodeEntities, htmlToText } from "../text.ts";

// SAP SuccessFactors Recruiting Marketing career sites (company domains).
//   GET https://{host}/sitemap.xml  → RSS 2.0 feed of every live job, with descriptions.
//   Some sites serve a standard <urlset> there and the RSS feed at /sitemal.xml instead.
// The /services/rss/job/ feed is robots-disallowed on these sites, so we use the sitemaps.
// Items carry no publish date: `first_seen_at` is the freshness signal.

export type SfItem = { id: string; title: string; link: string; location: string | null; description: string | null };

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  const v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return cdata ? cdata[1] : decodeEntities(v);
}

export function parseSfSitemap(xml: string): SfItem[] {
  const items: SfItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
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
};
