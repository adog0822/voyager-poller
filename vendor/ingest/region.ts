// US or abroad, from a posting's location text (and its URL, where Workday encodes the
// location). Multi-location roles with any US site count as US. Unclear = null, and null
// never hides a posting.

export type Region = "us" | "abroad";

const STATES =
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split(" ");
const STATE_SET = new Set(STATES);
const STATE_NAMES =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming|puerto rico)\b/i;
const US_WORDS = /\b(united states( of america)?|usa|u\.s\.a?\.?)\b/i;
const US_CITIES = /\b(boston|cambridge, ma|new york city|nyc|san francisco|seattle|chicago|austin|los angeles|washington,? d\.?c\.?|atlanta|denver|philadelphia|pittsburgh|detroit|houston|dallas|miami|san diego|san jose|palo alto|mountain view|menlo park|redmond|burlington, ma|waltham|somerville|charlotte|raleigh|minneapolis|st\.? louis|phoenix|portland|baltimore)\b/i;
const CA_PROVINCES = new Set(["ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU"]);
const CA_PROVINCE_NAMES = /\b(ontario|quebec|qu[ée]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland)\b/i;
const COUNTRIES =
  /\b(canada|mexico|united kingdom|england|scotland|wales|northern ireland|ireland|germany|france|netherlands|belgium|switzerland|austria|italy|spain|portugal|poland|czech( republic)?|czechia|hungary|romania|bulgaria|serbia|croatia|slovakia|slovenia|greece|turkey|t[üu]rkiye|israel|egypt|morocco|south africa|nigeria|kenya|india|china|hong kong|taiwan|japan|korea|singapore|malaysia|thailand|vietnam|philippines|indonesia|australia|new zealand|brazil|argentina|chile|colombia|peru|costa rica|sweden|norway|denmark|finland|estonia|latvia|lithuania|ukraine|uae|united arab emirates|saudi arabia|qatar|luxembourg|iceland|puerto vallarta|guadalajara|monterrey|bangalore|bengaluru|hyderabad|pune|shanghai|beijing|shenzhen|tokyo|seoul|london|paris|berlin|munich|dublin|toronto|montreal|vancouver|ottawa|calgary|waterloo|mississauga)\b/i;
const ABROAD_CODES = /(?:^|[\s,\-/(])(CAN|GBR|UK|DEU|FRA|IND|CHN|MEX|JPN|SGP|IRL|NLD|POL|ROU|BRA)(?=$|[\s,\-/)])/;

function tokens(s: string): string[] {
  return s.split(/[\s,\-/|()·]+/).filter(Boolean);
}

/** Workday/iCIMS put the location in the URL path: /job/Anoka-MN-US/..., /job/Brasov-RO/... */
function urlLocation(url: string | null | undefined): string {
  if (!url) return "";
  const m = url.match(/\/job\/([^/?#]{2,120})\//);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).replace(/-+/g, " ");
  } catch {
    return "";
  }
}

export function regionOf(location: string | null | undefined, url?: string | null): Region | null {
  const loc = (location ?? "").trim();
  const text = `${loc} ${/^\d+ locations?$/i.test(loc) || !loc ? urlLocation(url) : ""}`.trim();
  if (!text) return null;

  // iCIMS: country first, "US-MA-Boston", "CA-ON-Ottawa", "CA-Remote".
  const icims = loc.match(/^([A-Z]{2})-(?:[A-Z]{2}-)?\S/);
  if (icims) return icims[1] === "US" ? "us" : "abroad";

  const toks = tokens(text);
  const upper = toks.filter((t) => /^[A-Z]{2,3}$/.test(t));
  const hasProvince = upper.some((t) => CA_PROVINCES.has(t)) || CA_PROVINCE_NAMES.test(text);

  let us = US_WORDS.test(text) || toks.includes("US") || STATE_NAMES.test(text) || US_CITIES.test(text);
  // Two-letter state codes, but "CA" next to a Canadian province is Canada.
  if (!us) us = upper.some((t) => STATE_SET.has(t) && !(t === "CA" && hasProvince));
  if (us) return "us";

  if (hasProvince || COUNTRIES.test(text) || ABROAD_CODES.test(text)) return "abroad";
  // Trailing ISO country code that isn't a US state: "Brasov-RO", "Shugart, SG".
  const last = toks[toks.length - 1];
  if (last && /^[A-Z]{2}$/.test(last) && !STATE_SET.has(last)) return "abroad";
  return null;
}
