/**
 * Server-side web search for the chat `web_search` tool.
 * Brave Search when BRAVE_API_KEY is set, otherwise DuckDuckGo's HTML endpoint (no key).
 * The top pages are fetched and reduced to plain text so the model has something to cite.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SearchResult { title: string; url: string; description: string; content?: string }

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information (news, prices, recent events, facts you are unsure about). Returns titles, URLs and page excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        freshness: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'], description: 'How recent results must be' },
      },
      required: ['query'],
    },
  },
};

const UA = 'Mozilla/5.0 (compatible; TideSearch/0.1; +https://tide.network)';

export async function webSearch(query: string, freshness = 'all', count = 8): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 300);
  if (!q) return [];
  const results = process.env.BRAVE_API_KEY ? await brave(q, freshness, count) : await duckduckgo(q, count);
  // Enrich the top 3 with page text, in parallel, best effort.
  await Promise.all(results.slice(0, 3).map(async (r) => { r.content = await pageText(r.url).catch(() => undefined); }));
  return results;
}

async function brave(q: string, freshness: string, count: number): Promise<SearchResult[]> {
  const f = ({ day: 'pd', week: 'pw', month: 'pm', year: 'py' } as Record<string, string>)[freshness];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}${f ? `&freshness=${f}` : ''}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY! }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  const j = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
  return (j.web?.results ?? []).slice(0, count).map((x) => ({ title: strip(x.title), url: x.url, description: strip(x.description ?? '') }));
}

async function duckduckgo(q: string, count: number): Promise<SearchResult[]> {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: `q=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`search failed (${r.status})`);
  const html = await r.text();
  const out: SearchResult[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: strip(a[2]), url: href, description: strip(snip?.[1] ?? '') });
    if (out.length >= count) break;
  }
  return out;
}

// ------------------------------------------------------------------ page fetch with SSRF guard

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const v4 = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? privateIp(v4[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad scheme');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('bad port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((x) => privateIp(x.address))) throw new Error('blocked address');
  return u;
}

async function pageText(raw: string, maxChars = 1200): Promise<string> {
  let url = await safeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(4000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = await safeUrl(new URL(r.headers.get('location')!, url).toString());
      continue;
    }
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('text/html')) return '';
    const html = (await r.text()).slice(0, 400_000);
    const body = html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    return strip(body).slice(0, maxChars);
  }
  return '';
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function strip(s: string) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Format results as the tool message the model reads. */
export function formatForModel(query: string, results: SearchResult[]): string {
  if (!results.length) return `No results found for "${query}".`;
  const today = new Date().toISOString().slice(0, 10);
  return `Web results for "${query}" (retrieved ${today}). Cite sources by URL when you use them.\n\n` +
    results.slice(0, 5).map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description}${r.content ? `\n${r.content}` : ''}`).join('\n\n');
}

export const _test = { privateIp, safeUrl };

/** Indirection so tests can stub the network. */
export const searchProvider = { run: webSearch };
