'use client';

import { useEffect, useState } from 'react';

const KEY_STORAGE = 'serperApiKey';
const TAGS_STORAGE = 'extraRoleTags';

function toCsv(rows) {
  const headers = ['Name', 'Title / Headline', 'Seniority', 'Company', 'LinkedIn URL'];
  const esc = (v) => {
    const s = (v ?? '').toString();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.title, r.seniority, r.company, r.url].map(esc).join(','));
  }
  return lines.join('\n');
}

function downloadCsv(rows, company) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = company.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'company';
  a.href = url;
  a.download = `stakeholders-${safe}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [serperKey, setSerperKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');

  // Restore previously-saved key + tags (stored locally in this browser only).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(KEY_STORAGE);
      if (saved) {
        setSerperKey(saved);
        setShowKey(true);
      }
      const savedTags = JSON.parse(window.localStorage.getItem(TAGS_STORAGE) || '[]');
      if (Array.isArray(savedTags)) setTags(savedTags);
    } catch {}
  }, []);

  function persistTags(next) {
    setTags(next);
    try {
      window.localStorage.setItem(TAGS_STORAGE, JSON.stringify(next));
    } catch {}
  }

  function addTag(raw) {
    const v = raw.trim().replace(/,$/, '').trim();
    if (!v) return;
    const exists = tags.some((t) => t.toLowerCase() === v.toLowerCase());
    if (!exists && tags.length < 12) persistTags([...tags, v]);
    setTagInput('');
  }

  function onTagKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && tags.length) {
      persistTags(tags.slice(0, -1));
    }
  }

  function removeTag(t) {
    persistTags(tags.filter((x) => x !== t));
  }

  function onKeyChange(v) {
    setSerperKey(v);
    try {
      if (v.trim()) window.localStorage.setItem(KEY_STORAGE, v.trim());
      else window.localStorage.removeItem(KEY_STORAGE);
    } catch {}
  }

  async function search(e) {
    e?.preventDefault();
    const name = company.trim();
    if (!name || loading) return;
    setLoading(true);
    setError('');
    setData(null);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: name, serperKey: serperKey.trim(), extraRoles: tags }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  const results = data?.results || [];

  return (
    <main className="wrap">
      <h1>Outreach Stakeholder Finder</h1>
      <p className="sub">
        Enter a company name to find senior stakeholders (CEO, CFO, COO, CTO, VP, Director,
        Founder…) from public search results, then export to CSV.
      </p>

      <form className="searchbar" onSubmit={search}>
        <input
          type="text"
          placeholder="Company name — e.g. Stripe"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <button type="submit" disabled={loading || !company.trim()}>
          {loading ? 'Searching…' : 'Find stakeholders'}
        </button>
      </form>

      <div className="tagsblock">
        <label className="taglabel">Extra title tags to search (optional)</label>
        <div className="tagsinput" onClick={() => document.getElementById('tagfield')?.focus()}>
          {tags.map((t) => (
            <span className="chip" key={t}>
              {t}
              <button type="button" className="chipx" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}>
                ×
              </button>
            </span>
          ))}
          <input
            id="tagfield"
            type="text"
            className="taginput"
            placeholder={tags.length ? 'Add another…' : 'e.g. Head of Sales, Chief Revenue Officer — Enter to add'}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={onTagKeyDown}
            onBlur={() => addTag(tagInput)}
            disabled={loading}
          />
        </div>
        <span className="keyhint">
          Adds these titles to the search and labels matching profiles. Built-in roles (CEO, CFO,
          COO, CTO, President, Founder, VP, Director, Head) are always included.
        </span>
      </div>

      <div className="keyrow">
        {!showKey ? (
          <button type="button" className="link" onClick={() => setShowKey(true)}>
            + Add Serper API key (recommended — enables Google results)
          </button>
        ) : (
          <div className="keyfield">
            <input
              type="password"
              placeholder="Serper.dev API key (optional — get a free key at serper.dev)"
              value={serperKey}
              onChange={(e) => onKeyChange(e.target.value)}
              disabled={loading}
              autoComplete="off"
            />
            <span className="keyhint">
              {serperKey.trim() ? 'Saved in this browser.' : 'Stored locally only — never sent anywhere but your own /api/search.'}
            </span>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {data && (
        <>
          <div className="bar">
            <span className="meta">
              {results.length} {results.length === 1 ? 'result' : 'results'} · source:{' '}
              {data.provider === 'serper' ? 'Google (Serper)' : 'DuckDuckGo'}
            </span>
            <button
              className="ghost"
              onClick={() => downloadCsv(results, company.trim())}
              disabled={!results.length}
            >
              Download CSV
            </button>
          </div>

          {results.length === 0 ? (
            <div className="empty">
              No public results matched. Try the full legal company name, or add a
              <code> SERPER_API_KEY</code> (see README) for Google-quality results.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title / Headline</th>
                  <th>Seniority</th>
                  <th>LinkedIn</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.url}>
                    <td>{r.name}</td>
                    <td>{r.title}</td>
                    <td>
                      <span className="tag">{r.seniority}</span>
                    </td>
                    <td>
                      <a href={r.url} target="_blank" rel="noopener noreferrer">
                        Profile ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <p className="note">
        Data comes only from public search-engine results — the app does not log into or crawl
        LinkedIn. Coverage depends on what is publicly indexed and is best-effort. Use responsibly
        and in line with applicable privacy/outreach regulations.
      </p>
    </main>
  );
}
