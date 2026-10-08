// Minimal robots.txt (RFC 9309) matcher: group selection by user-agent token,
// Allow/Disallow with longest-match precedence, `*` and `$` wildcards, Crawl-delay.

export type RobotsRules = {
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySec: number | null;
  /** robots.txt couldn't be fetched (5xx, network): treat as "not now", not as a site's answer. */
  unreachable?: boolean;
};

export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelaySec: null };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: "/" }], crawlDelaySec: null };
export const UNREACHABLE: RobotsRules = { ...DISALLOW_ALL, unreachable: true };

/** Case-insensitive variant for app paths whose case isn't canonical (Workday site names). */
export function isPathAllowedIgnoreCase(robots: RobotsRules, path: string): boolean {
  return isPathAllowed({ ...robots, rules: robots.rules.map((r) => ({ ...r, pattern: r.pattern.toLowerCase() })) }, path.toLowerCase());
}

/** RFC 9309: parse at most 500 KiB. Rules longer than this are ignored. */
const MAX_ROBOTS_CHARS = 500 * 1024;
const MAX_RULE_CHARS = 512;

export function parseRobots(txt: string, userAgentToken: string): RobotsRules {
  txt = txt.slice(0, MAX_ROBOTS_CHARS);
  const token = userAgentToken.toLowerCase();
  type Group = { agents: string[]; rules: RobotsRules["rules"]; crawlDelaySec: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "" || value.length > MAX_RULE_CHARS) continue; // "Disallow:" (empty) = allow everything
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  if (!chosen.length) return ALLOW_ALL;
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySec: chosen.map((g) => g.crawlDelaySec).find((d) => d !== null) ?? null,
  };
}

/**
 * Linear-time robots.txt pattern match (`*` = any run, trailing `$` = end anchor).
 * No regex: patterns come from untrusted sites, and wildcard→regex conversion backtracks
 * catastrophically on inputs like "/**********Z$" (seconds to minutes per check).
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  // First segment must be a prefix.
  if (!path.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  // Middle segments: greedy-leftmost search is optimal for "*" gaps.
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue;
    const at = path.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  if (parts.length === 1) return anchored ? path.length === pos : true;
  const last = parts[parts.length - 1];
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === "" || path.indexOf(last, pos) >= 0;
}

/** `path` includes the query string, e.g. "/jobs?x=1". */
export function isPathAllowed(robots: RobotsRules, path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (!matchesPattern(r.pattern, path)) continue;
    const len = r.pattern.length;
    // Longest match wins; on a tie, Allow wins (RFC 9309 §2.2.2).
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}
