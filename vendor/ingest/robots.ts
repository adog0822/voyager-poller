// Minimal robots.txt (RFC 9309) matcher: group selection by user-agent token,
// Allow/Disallow with longest-match precedence, `*` and `$` wildcards, Crawl-delay.

export type RobotsRules = {
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySec: number | null;
};

export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelaySec: null };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: "/" }], crawlDelaySec: null };

export function parseRobots(txt: string, userAgentToken: string): RobotsRules {
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
      if (value === "") continue; // "Disallow:" (empty) = allow everything
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

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** `path` includes the query string, e.g. "/jobs?x=1". */
export function isPathAllowed(robots: RobotsRules, path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (!patternToRegex(r.pattern).test(path)) continue;
    const len = r.pattern.length;
    // Longest match wins; on a tie, Allow wins (RFC 9309 §2.2.2).
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}
