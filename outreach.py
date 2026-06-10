#!/usr/bin/env python3
"""
Outreach Stakeholder Finder (CLI).

Find senior stakeholders (CEO/CFO/COO/CTO/CMO/President/Founder/VP/Director/Head,
plus any custom title tags) at a company from public search results, and write a CSV
with name, title, seniority, company, and LinkedIn URL.

This is the CLI twin of the Next.js app in this repo. It reads only public
search-engine results; it does not log into or crawl LinkedIn.

Usage:
    python outreach.py "Datadog" --key YOUR_SERPER_KEY
    python outreach.py "Stripe" --tags "Engineering Manager" "Chief Revenue Officer"
    SERPER_API_KEY=... python outreach.py "Acme" -o acme.csv

Get a free Serper key at https://serper.dev. Without a key it falls back to
keyless DuckDuckGo/Bing, which are frequently bot-blocked and may return nothing.
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Seniority groups, kept compact so a single SERP page covers more ground.
ROLE_GROUPS = [
    ["CEO", "CFO", "COO", "CTO", "CMO", "President", "Founder", "Co-Founder", "Chief"],
    ["VP", "Vice President", "Director", "Head"],
]

# (rank, label, compiled regex). Lower rank == more senior == sorted first.
TITLE_PATTERNS = [
    (1, "CEO", re.compile(r"\bchief executive officer\b|\bceo\b", re.I)),
    (1, "Founder", re.compile(r"\b(co[-\s]?)?founder\b", re.I)),
    (1, "President", re.compile(r"(?<!vice[\s-])\bpresident\b", re.I)),
    (2, "CFO", re.compile(r"\bchief financial officer\b|\bcfo\b", re.I)),
    (2, "COO", re.compile(r"\bchief operating officer\b|\bcoo\b", re.I)),
    (2, "CTO", re.compile(r"\bchief technology officer\b|\bcto\b", re.I)),
    (2, "CMO", re.compile(r"\bchief marketing officer\b|\bcmo\b", re.I)),
    (2, "Chief", re.compile(r"\bchief\b", re.I)),
    (3, "VP", re.compile(r"\bvp\b|\bvice president\b|\bsvp\b|\bevp\b", re.I)),
    (4, "Director", re.compile(r"\bdirector\b", re.I)),
    (4, "Head", re.compile(r"\bhead of\b", re.I)),
]

STOPWORDS = {"inc", "llc", "ltd", "the", "and", "corp"}


def classify_title(text):
    if not text:
        return None
    for rank, label, rx in TITLE_PATTERNS:
        if rx.search(text):
            return {"label": label, "rank": rank}
    return None


def classify_custom(text, extra_roles):
    """Match user-supplied tags (e.g. 'Head of Sales') as case-insensitive phrases."""
    if not text or not extra_roles:
        return None
    lc = text.lower()
    for tag in extra_roles:
        t = tag.strip()
        if len(t) >= 2 and t.lower() in lc:
            return {"label": t, "rank": 5}
    return None


def build_serper_query(company, roles):
    # Serper FREE tier rejects both `site:` and quoted phrases, so keep it natural.
    unquoted = [r.replace('"', "") for r in roles]
    return f'{company.replace(chr(34), "")} ({" OR ".join(unquoted)}) linkedin'


def build_keyless_query(company, roles):
    return f'site:linkedin.com/in/ "{company}" ({" OR ".join(roles)})'


def company_tokens_of(company):
    return [
        t
        for t in re.split(r"[^a-z0-9]+", company.lower())
        if len(t) >= 3 and t not in STOPWORDS
    ]


def mentions_company(text, tokens):
    lc = (text or "").lower()
    return any(len(t) >= 3 and t in lc for t in tokens)


def profile_slug(url):
    m = re.search(r"linkedin\.com/in/([^/?#]+)", url, re.I)
    return urllib.parse.unquote(m.group(1)).lower() if m else None


def parse_title(raw_title):
    """'Jane Doe - CEO - Acme | LinkedIn' -> ('Jane Doe', 'CEO · Acme')."""
    t = re.sub(r"\s*[-|]\s*LinkedIn\s*$", "", raw_title or "", flags=re.I).strip()
    parts = [p.strip() for p in re.split(r"\s+[-–|]\s+", t) if p.strip()]
    if not parts:
        return "", ""
    return parts[0], " · ".join(parts[1:])


# ---- Providers ----------------------------------------------------------------

def _post_json(url, payload, headers, timeout=30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def fetch_serper(query, api_key):
    headers = {"X-API-KEY": api_key, "Content-Type": "application/json"}
    try:
        status, body = _post_json(
            "https://google.serper.dev/search", {"q": query, "num": 30}, headers
        )
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Serper {e.code}: {e.read().decode('utf-8','replace')[:120]}")
    data = json.loads(body)
    return [
        {"url": o.get("link", ""), "title": o.get("title", ""), "snippet": o.get("snippet", "")}
        for o in data.get("organic", [])
    ]


def fetch_duckduckgo(query):
    body = urllib.parse.urlencode({"q": query}).encode()
    req = urllib.request.Request(
        "https://html.duckduckgo.com/html/",
        data=body,
        headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:  # 202 == bot challenge
            raise RuntimeError(f"DuckDuckGo {resp.status} (bot-gated)")
        html = resp.read().decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
        href = m.group(1)
        uddg = re.search(r"[?&]uddg=([^&]+)", href)
        if uddg:
            href = urllib.parse.unquote(uddg.group(1))
        out.append({"url": href, "title": _strip_tags(m.group(2)), "snippet": ""})
    return out


def fetch_bing(query):
    url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}&count=30&setlang=en-US"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status != 200:
            raise RuntimeError(f"Bing {resp.status}")
        html = resp.read().decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'<h2><a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a></h2>', html, re.S):
        out.append({"url": m.group(1), "title": _strip_tags(m.group(2)), "snippet": ""})
    return out


def _strip_tags(s):
    s = re.sub(r"<[^>]*>", " ", s or "")
    for a, b in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")]:
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def run_query(query, api_key):
    if api_key:
        return fetch_serper(query, api_key)
    # Keyless: try both, merge (frequently bot-blocked; best-effort).
    merged, any_ok, errs = [], False, []
    for fn in (fetch_duckduckgo, fetch_bing):
        try:
            merged += fn(query)
            any_ok = True
        except Exception as e:  # noqa: BLE001
            errs.append(str(e))
    if not any_ok:
        raise RuntimeError("; ".join(errs))
    return merged


# ---- Core ---------------------------------------------------------------------

def process_results(company, raw, extra_roles=None):
    extra_roles = extra_roles or []
    tokens = company_tokens_of(company)
    by_slug = {}
    for r in raw:
        url = r.get("url", "")
        if "linkedin.com/in/" not in url.lower():
            continue
        slug = profile_slug(url)
        if not slug:
            continue
        name, headline = parse_title(r.get("title", ""))
        haystack = f"{r.get('title', '')} {r.get('snippet', '')}"
        cls = classify_title(haystack) or classify_title(headline) or classify_custom(haystack, extra_roles)
        if not cls:
            continue
        if tokens and not mentions_company(f"{haystack} {url}", tokens):
            continue
        clean_url = f"https://www.linkedin.com/in/{slug}"
        cand = {
            "name": name or slug.replace("-", " "),
            "title": headline or cls["label"],
            "seniority": cls["label"],
            "rank": cls["rank"],
            "company": company,
            "url": clean_url,
        }
        ex = by_slug.get(slug)
        if not ex or cand["rank"] < ex["rank"] or (not ex["title"] and cand["title"]):
            by_slug[slug] = cand
    results = sorted(by_slug.values(), key=lambda x: (x["rank"], x["name"].lower()))
    return results


def find_stakeholders(company, api_key=None, extra_roles=None):
    extra_roles = [t.strip() for t in (extra_roles or []) if t.strip()][:12]
    build = build_serper_query if api_key else build_keyless_query
    queries = [build(company, roles) for roles in ROLE_GROUPS]
    if extra_roles:
        queries.append(build(company, extra_roles))

    raw, errors = [], []
    with ThreadPoolExecutor(max_workers=len(queries)) as pool:
        futures = [pool.submit(run_query, q, api_key) for q in queries]
        for f in futures:
            try:
                raw += f.result()
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))

    results = process_results(company, raw, extra_roles)
    return {
        "provider": "serper" if api_key else "duckduckgo/bing",
        "count": len(results),
        "results": results,
        "errors": errors,
    }


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Name", "Title / Headline", "Seniority", "Company", "LinkedIn URL"])
        for r in rows:
            w.writerow([r["name"], r["title"], r["seniority"], r["company"], r["url"]])


def main(argv=None):
    p = argparse.ArgumentParser(description="Find senior stakeholders at a company and export CSV.")
    p.add_argument("company", help="Company name, e.g. 'Datadog' (use the full legal name).")
    p.add_argument("--key", default=os.environ.get("SERPER_API_KEY"),
                   help="Serper.dev API key (or set SERPER_API_KEY). Free tier works.")
    p.add_argument("--tags", nargs="*", default=[],
                   help="Extra title tags to also search, e.g. --tags 'Head of Sales' 'CRO'.")
    p.add_argument("-o", "--out", help="Output CSV path (default: stakeholders-<company>.csv).")
    args = p.parse_args(argv)

    if not args.key:
        print("WARNING: no Serper key (--key or SERPER_API_KEY). Falling back to keyless "
              "engines, which are usually bot-blocked and may return nothing.\n", file=sys.stderr)

    data = find_stakeholders(args.company, api_key=args.key, extra_roles=args.tags)

    print(f"Provider: {data['provider']}  |  Results: {data['count']}")
    if data["errors"]:
        print(f"Notes: {data['errors']}", file=sys.stderr)
    for r in data["results"]:
        print(f"  [{r['seniority']:<9}] {r['name']}  —  {r['title']}  —  {r['url']}")

    out = args.out or "stakeholders-" + re.sub(r"[^a-z0-9]+", "-", args.company.lower()).strip("-") + ".csv"
    write_csv(out, data["results"])
    print(f"\nWrote {data['count']} rows to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
