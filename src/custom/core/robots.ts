/**
 * Minimal robots.txt support (RFC 9309): the group for the `*` user-agent, Allow/Disallow with
 * `*` wildcards and a `$` end anchor, longest match wins, Allow wins a tie.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [] };

export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [] };
  let groupAgents: string[] = [];
  let inRules = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === 'user-agent') {
      // A user-agent line after rules starts a new group
      if (inRules) { groupAgents = []; inRules = false; }
      groupAgents.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    inRules = true;
    if (!groupAgents.includes('*') || !value) continue; // empty Disallow = allow everything
    (field === 'allow' ? rules.allow : rules.disallow).push(value);
  }
  return rules;
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** pathAndQuery: URL pathname + search, e.g. "/en/search?q=x" */
export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best = { len: -1, allow: true };
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!toRegex(p).test(pathAndQuery)) continue;
      if (p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best.allow;
}
