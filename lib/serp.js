// Server-side SERP search + LinkedIn-profile parsing.
//
// Two providers:
//   1. Serper.dev (Google) — used automatically if SERPER_API_KEY is set. Reliable.
//   2. DuckDuckGo HTML endpoint — keyless fallback. No login, tolerates `site:` queries.
//
// This only reads PUBLIC search-engine results. It does not log into LinkedIn or
// crawl profile pages, so it stays clear of LinkedIn's anti-scraping ToS.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Seniority groups. Kept in two queries so a single SERP page covers more ground.
const ROLE_GROUPS = [
  ['CEO', 'CFO', 'COO', 'CTO', 'CMO', 'President', 'Founder', 'Co-Founder', 'Chief'],
  ['VP', '"Vice President"', 'Director', 'Head'],
];

// Used to classify/keep a result and to label seniority.
const TITLE_PATTERNS = [
  { rank: 1, label: 'CEO', re: /\bchief executive officer\b|\bceo\b/i },
  { rank: 1, label: 'Founder', re: /\b(co[-\s]?)?founder\b/i },
  { rank: 1, label: 'President', re: /(?<!vice[\s-])\bpresident\b/i },
  { rank: 2, label: 'CFO', re: /\bchief financial officer\b|\bcfo\b/i },
  { rank: 2, label: 'COO', re: /\bchief operating officer\b|\bcoo\b/i },
  { rank: 2, label: 'CTO', re: /\bchief technology officer\b|\bcto\b/i },
  { rank: 2, label: 'CMO', re: /\bchief marketing officer\b|\bcmo\b/i },
  { rank: 2, label: 'Chief', re: /\bchief\b/i },
  { rank: 3, label: 'VP', re: /\bvp\b|\bvice president\b|\bsvp\b|\bevp\b/i },
  { rank: 4, label: 'Director', re: /\bdirector\b/i },
  { rank: 4, label: 'Head', re: /\bhead of\b/i },
];

function classifyTitle(text) {
  if (!text) return null;
  for (const p of TITLE_PATTERNS) {
    if (p.re.test(text)) return { label: p.label, rank: p.rank };
  }
  return null;
}

// User-supplied custom tags (e.g. "Head of Sales", "Chief Revenue Officer").
// Matched as a case-insensitive phrase; ranked after built-in seniorities.
function classifyCustom(text, extraRoles) {
  if (!text || !extraRoles?.length) return null;
  const lc = text.toLowerCase();
  for (const tag of extraRoles) {
    const t = tag.trim();
    if (t.length >= 2 && lc.includes(t.toLowerCase())) {
      return { label: t, rank: 5 };
    }
  }
  return null;
}

// Keyless engines (DDG/Bing) honor the `site:` operator, so we constrain to
// LinkedIn profiles directly.
function buildKeylessQuery(company, roles) {
  return `site:linkedin.com/in/ "${company}" (${roles.join(' OR ')})`;
}

// Serper's FREE tier rejects BOTH the `site:` operator and quoted phrases
// ("Query pattern not allowed for free accounts"). So we use a natural,
// quote-free query and rely on the downstream /in/ filter + company-name match
// to keep only relevant LinkedIn profiles.
function buildSerperQuery(company, roles) {
  const unquoted = roles.map((r) => r.replace(/"/g, ''));
  return `${company.replace(/"/g, '')} (${unquoted.join(' OR ')}) linkedin`;
}

// Pull the canonical /in/<slug> profile slug, ignoring locale prefixes & query strings.
function profileSlug(url) {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

// Split a LinkedIn SERP title into { name, headline }.
// Typical forms: "Jane Doe - CEO - Acme | LinkedIn", "Jane Doe - Acme | LinkedIn".
function parseTitle(rawTitle) {
  let t = (rawTitle || '').replace(/\s*[-|]\s*LinkedIn\s*$/i, '').trim();
  const parts = t.split(/\s+[-–|]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { name: '', headline: '' };
  const name = parts[0];
  const headline = parts.slice(1).join(' · ');
  return { name, headline };
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities((s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---- Provider: Serper.dev (Google) ----
async function fetchSerper(query, apiKey) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 30 }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const data = await res.json();
  return (data.organic || []).map((r) => ({
    url: r.link || '',
    title: r.title || '',
    snippet: r.snippet || '',
  }));
}

// ---- Provider: DuckDuckGo HTML (keyless) ----
async function fetchDuckDuckGo(query) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  // DDG serves its bot challenge as HTTP 202, so only a clean 200 counts.
  if (res.status !== 200) throw new Error(`DuckDuckGo ${res.status} (bot-gated)`);
  const html = await res.text();
  const out = [];

  // Each result anchor: <a ... class="result__a" href="...">TITLE</a>
  const anchorRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    let href = decodeEntities(m[1]);
    // DDG wraps links: //duckduckgo.com/l/?uddg=<encoded-real-url>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    out.push({ url: href, title: stripTags(m[2]), snippet: '' });
  }

  // Attach snippets positionally (best-effort).
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0;
  let sm;
  while ((sm = snippetRe.exec(html)) !== null && i < out.length) {
    out[i].snippet = stripTags(sm[1]);
    i++;
  }
  return out;
}

async function runQuery(query, apiKey) {
  if (apiKey) return fetchSerper(query, apiKey);
  // Keyless: try both engines and merge (downstream dedupes). Both are
  // frequently bot-gated, so this is best-effort and may return nothing
  // without a SERPER_API_KEY. If BOTH fail, surface the error.
  const settled = await Promise.allSettled([fetchDuckDuckGo(query), fetchBing(query)]);
  const merged = [];
  let anyOk = false;
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      anyOk = true;
      merged.push(...s.value);
    }
  }
  if (!anyOk) throw new Error(settled.map((s) => s.reason?.message).filter(Boolean).join('; '));
  return merged;
}

// ---- Provider: Bing HTML (keyless fallback) ----
async function fetchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30&setlang=en-US`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<h2><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ url: decodeEntities(m[1]), title: stripTags(m[2]), snippet: '' });
  }
  return out;
}

// Loose company match: does the result mention the company token(s)?
function mentionsCompany(text, companyTokens) {
  const lc = (text || '').toLowerCase();
  return companyTokens.some((tok) => tok.length >= 3 && lc.includes(tok));
}

function companyTokensOf(company) {
  return company
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['inc', 'llc', 'ltd', 'the', 'and', 'corp'].includes(t));
}

// Pure: turn raw SERP results into the final, filtered, deduped stakeholder list.
// Exported so the parse/classify/dedupe logic can be tested without network access.
export function processResults(company, raw, extraRoles = []) {
  const companyTokens = companyTokensOf(company);
  const bySlug = new Map();
  for (const r of raw) {
    if (!/linkedin\.com\/in\//i.test(r.url)) continue;
    const slug = profileSlug(r.url);
    if (!slug) continue;

    const { name, headline } = parseTitle(r.title);
    const haystack = `${r.title} ${r.snippet}`;
    // Built-in seniority first, then user-supplied custom tags.
    const cls =
      classifyTitle(haystack) ||
      classifyTitle(headline) ||
      classifyCustom(haystack, extraRoles);
    if (!cls) continue; // not a target seniority or custom tag

    // Keep only results that plausibly belong to the company (if we have tokens).
    if (companyTokens.length && !mentionsCompany(`${haystack} ${r.url}`, companyTokens)) {
      continue;
    }

    const cleanUrl = `https://www.linkedin.com/in/${slug}`;
    const existing = bySlug.get(slug);
    const candidate = {
      name: name || slug.replace(/-/g, ' '),
      title: headline || cls.label,
      seniority: cls.label,
      rank: cls.rank,
      company,
      url: cleanUrl,
      source: r.snippet || '',
    };
    // On duplicate, keep the higher-seniority / richer record.
    if (!existing || candidate.rank < existing.rank || (!existing.title && candidate.title)) {
      bySlug.set(slug, candidate);
    }
  }

  return Array.from(bySlug.values()).sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
}

export async function findStakeholders(company, keyOverride, extraRoles = []) {
  // Prefer a key supplied per-request (from the UI), else the server env var.
  const apiKey = (keyOverride && keyOverride.trim()) || process.env.SERPER_API_KEY?.trim() || null;
  const tags = (extraRoles || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 12);

  const build = (roles) =>
    apiKey ? buildSerperQuery(company, roles) : buildKeylessQuery(company, roles);
  const queries = ROLE_GROUPS.map(build);
  // Run the custom tags as their own query group so those people surface too.
  if (tags.length) queries.push(build(tags));

  const settled = await Promise.allSettled(queries.map((q) => runQuery(q, apiKey)));
  const raw = [];
  const errors = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') raw.push(...s.value);
    else errors.push(String(s.reason?.message || s.reason));
  }

  const results = processResults(company, raw, tags);
  return {
    provider: apiKey ? 'serper' : 'duckduckgo/bing',
    count: results.length,
    results,
    errors,
  };
}
