// api/search.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    image?: string;
}

type Category = 'general' | 'images' | 'news';

interface SearchParams {
    q: string;
    category: Category;
    lang: string;
    pageno: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
    res.setHeader('Access-Control-Expose-Headers', 'X-Jillex-Debug');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const q = typeof req.query.q === 'string' ? req.query.q : Array.isArray(req.query.q) ? req.query.q[0] : '';
    if (!q) {
        return res.status(200).json([]);
    }

    const categoryRaw = typeof req.query.category === 'string' ? req.query.category : '';
    const category: Category = (['general', 'images', 'news'] as const).includes(categoryRaw as Category)
        ? (categoryRaw as Category)
        : 'general';
    const langRaw = typeof req.query.lang === 'string' ? req.query.lang : '';
    const lang = langRaw && langRaw !== 'all' ? langRaw : 'all';
    const pagenoRaw = typeof req.query.pageno === 'string' ? parseInt(req.query.pageno, 10) : NaN;
    const pageno = Math.max(1, Number.isFinite(pagenoRaw) ? pagenoRaw : 1);

    const params: SearchParams = { q, category, lang, pageno };
    const attempts: string[] = [];

    try {
        let results: SearchResult[] = [];

        // ================= AŞAMA 1: Yahoo — doğrudan + proxy rotasyonu (sırayla dener) =================
        if (category === 'general') {
            results = await fetchYahooWithProxies(params, attempts);
        }

        // ================= AŞAMA 2: Wikipedia (son çare) =================
        if (results.length === 0 && category === 'general' && pageno === 1) {
            results = await fetchWikipediaFallback(q);
            attempts.push(`Wikipedia yedek: ${results.length} sonuç`);
        }

        console.log(`[JILLEX] "${q}" (${category}) denemeleri:\n - ${attempts.join('\n - ')}`);
        res.setHeader('X-Jillex-Debug', encodeURIComponent(attempts.join(' | ')));
        return res.status(200).json(results);

    } catch (error: any) {
        console.error('[JILLEX SERVER ERROR]:', error?.message, attempts);

        let fallbackResults: SearchResult[] = [];
        if (category === 'general' && pageno === 1) {
            try {
                fallbackResults = await fetchWikipediaFallback(q);
            } catch (e) {
                // yut, boş dizi dön
            }
        }
        res.setHeader('X-Jillex-Debug', encodeURIComponent(`HATA: ${error?.message}` + (attempts.length ? ' | ' + attempts.join(' | ') : '')));
        return res.status(200).json(fallbackResults);
    }
}

// ================= Yahoo — çıkış noktası rotasyonu =================
// Vercel'in sabit datacenter IP'si Yahoo tarafından rate-limit'lenebiliyor.
// Farklı CORS/HTML proxy'leri üzerinden farklı çıkış IP'siyle sırayla deniyoruz.
// Sırayla deniyoruz (paralel değil) çünkü aynı anda çok istek atmak engellenme ihtimalini artırır.
function buildYahooUrl(params: SearchParams): string {
    const usp = new URLSearchParams({ p: params.q });
    if (params.pageno > 1) usp.set('b', String((params.pageno - 1) * 10 + 1));
    return `https://search.yahoo.com/search?${usp.toString()}`;
}

interface FetchAttempt {
    name: string;
    build: (targetUrl: string) => { url: string; headers: Record<string, string> };
}

const FETCH_STRATEGIES: FetchAttempt[] = [
    {
        name: 'doğrudan',
        build: (targetUrl) => ({
            url: targetUrl,
            headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Cookie': 'A1=; consent=1' }
        })
    },
    {
        name: 'corsproxy.io',
        build: (targetUrl) => ({
            url: `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
            headers: { 'User-Agent': UA, 'Accept': 'text/html' }
        })
    },
    {
        name: 'allorigins',
        build: (targetUrl) => ({
            url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
            headers: { 'User-Agent': UA, 'Accept': 'text/html' }
        })
    },
    {
        name: 'codetabs',
        build: (targetUrl) => ({
            url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
            headers: { 'User-Agent': UA, 'Accept': 'text/html' }
        })
    }
];

async function fetchYahooWithProxies(params: SearchParams, attempts: string[]): Promise<SearchResult[]> {
    const targetUrl = buildYahooUrl(params);

    for (const strategy of FETCH_STRATEGIES) {
        try {
            const { url, headers } = strategy.build(targetUrl);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);

            const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
            clearTimeout(timer);

            if (!response.ok) {
                attempts.push(`Yahoo (${strategy.name}) hata: HTTP ${response.status}`);
                continue;
            }

            const html = await response.text();
            const results = parseYahooHtml(html);
            attempts.push(`Yahoo (${strategy.name}): ${results.length} sonuç`);

            if (results.length > 0) return results;
        } catch (e: any) {
            attempts.push(`Yahoo (${strategy.name}) hata: ${e?.message || String(e)}`);
        }
    }

    return [];
}

// URL-pattern tabanlı parser: Yahoo'nun class isimleri sık değiştiği için
// "r.search.yahoo.com/...RU=<gerçek-url>/..." pattern'ine güveniyoruz — bu çok daha stabil.
function parseYahooHtml(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    // Tüm <a href="...r.search.yahoo.com...RU=...">başlık</a> bloklarını bul
    const linkRegex = /<a[^>]+href="(https?:\/\/r\.search\.yahoo\.com\/[^"]*\/RU=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(html)) !== null) {
        const rawHref = decodeHtmlEntities(match[1]);
        const rawTitle = stripHtml(match[2]);
        const url = extractYahooRealUrl(rawHref);

        if (!url || !url.startsWith('http') || !rawTitle) continue;
        if (seen.has(url)) continue;

        // Snippet'i link sonrası ~600 karaktere bakıp ilk anlamlı <p> içeriğinden çekmeye çalış
        const afterLink = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
        const snippetMatch = afterLink.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';

        seen.add(url);
        results.push({ title: rawTitle, url, snippet });
    }

    return results;
}

// Yahoo linkleri r.search.yahoo.com üzerinden redirect ediyor, gerçek URL "RU=" içinde
function extractYahooRealUrl(href: string): string {
    try {
        const match = href.match(/\/RU=([^/]+)\//);
        if (match) return decodeURIComponent(match[1]);
        return href;
    } catch (e) {
        return href;
    }
}

function stripHtml(str: string): string {
    return decodeHtmlEntities(str.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

// ================= WIKIPEDIA — en son çare =================
async function fetchWikipediaFallback(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const wikiUrl = `https://tr.wikipedia.org/w/api.php?action=opensearch&format=json&search=${encodeURIComponent(query)}`;
    const wikiRes = await fetch(wikiUrl);
    if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        const titles: string[] = wikiData[1] || [];
        const descriptions: string[] = wikiData[2] || [];
        const links: string[] = wikiData[3] || [];

        for (let i = 0; i < titles.length; i++) {
            results.push({
                title: titles[i],
                url: links[i],
                snippet: descriptions[i] || `${titles[i]} hakkında bilgi.`
            });
        }
    }
    return results;
}
