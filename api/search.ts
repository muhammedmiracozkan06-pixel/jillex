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

// Gerçek Chrome 126 (Windows) tarayıcısının gönderdiği tam header seti.
// Sadece User-Agent yetmiyor — sec-ch-ua, sec-fetch-*, Accept-Encoding gibi
// başlıkların eksik/tutarsız olması bot tespiti sinyali oluşturuyor.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function browserHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Connection': 'keep-alive',
        ...(extra || {})
    };
}

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

        // ================= AŞAMA 1: DuckDuckGo — çoklu varyant + proxy rotasyonu =================
        if (category === 'general') {
            results = await fetchDuckDuckGoWithProxies(params, attempts);
        }

        // ================= AŞAMA 2: Yahoo — yedek =================
        if (results.length === 0 && category === 'general') {
            results = await fetchYahooWithProxies(params, attempts);
        }

        // ================= AŞAMA 3: Wikipedia (son çare) =================
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

// ================= PROXY HAVUZU =================
// Farklı çıkış IP'si sağlayan ücretsiz CORS/HTML proxy'leri.
// Vercel'in sabit datacenter IP aralığı DDG/Yahoo tarafından toplu engellenmiş olabilir;
// proxy'ler farklı IP bloklarından çıkış yaptığı için engeli aşma ihtimali var.
function wrapWithProxy(targetUrl: string, proxyName: string): string {
    switch (proxyName) {
        case 'doğrudan':
            return targetUrl;
        case 'corsproxy.io':
            return `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
        case 'allorigins':
            return `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
        case 'codetabs':
            return `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
        case 'thingproxy':
            return `https://thingproxy.freeboard.io/fetch/${targetUrl}`;
        default:
            return targetUrl;
    }
}

const PROXY_NAMES = ['doğrudan', 'corsproxy.io', 'allorigins', 'codetabs', 'thingproxy'];

async function fetchWithTimeout(url: string, headers: Record<string, string>, ms: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { method: 'GET', headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ================= DuckDuckGo — çoklu varyant (html + lite) x proxy rotasyonu =================
function buildDdgHtmlUrl(params: SearchParams): string {
    const KL_MAP: Record<string, string> = { tr: 'tr-tr', en: 'us-en', de: 'de-de', fr: 'fr-fr', es: 'es-es' };
    const usp = new URLSearchParams({ q: params.q });
    if (KL_MAP[params.lang]) usp.set('kl', KL_MAP[params.lang]);
    if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 30));
    return `https://html.duckduckgo.com/html/?${usp.toString()}`;
}

function buildDdgLiteUrl(params: SearchParams): string {
    const KL_MAP: Record<string, string> = { tr: 'tr-tr', en: 'us-en', de: 'de-de', fr: 'fr-fr', es: 'es-es' };
    const usp = new URLSearchParams({ q: params.q });
    if (KL_MAP[params.lang]) usp.set('kl', KL_MAP[params.lang]);
    if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 30));
    return `https://lite.duckduckgo.com/lite/?${usp.toString()}`;
}

async function fetchDuckDuckGoWithProxies(params: SearchParams, attempts: string[]): Promise<SearchResult[]> {
    const variants: { label: string; buildUrl: (p: SearchParams) => string; referer: string }[] = [
        { label: 'html', buildUrl: buildDdgHtmlUrl, referer: 'https://duckduckgo.com/' },
        { label: 'lite', buildUrl: buildDdgLiteUrl, referer: 'https://lite.duckduckgo.com/' }
    ];

    const deadline = Date.now() + 20000; // toplam bütçe: 20sn (Yahoo yedeğine de zaman kalsın)

    for (const proxyName of PROXY_NAMES) {
        for (const variant of variants) {
            if (Date.now() > deadline) return [];
            try {
                const targetUrl = variant.buildUrl(params);
                const fetchUrl = wrapWithProxy(targetUrl, proxyName);
                const headers = proxyName === 'doğrudan'
                    ? browserHeaders({ 'Referer': variant.referer, 'Host': new URL(targetUrl).host })
                    : browserHeaders();

                const response = await fetchWithTimeout(fetchUrl, headers, 4000);

                if (!response.ok) {
                    attempts.push(`DDG ${variant.label} (${proxyName}) hata: HTTP ${response.status}`);
                    continue;
                }

                const html = await response.text();
                const results = variant.label === 'html' ? parseDdgHtml(html) : parseDdgLite(html);
                attempts.push(`DDG ${variant.label} (${proxyName}): ${results.length} sonuç (uzunluk: ${html.length})`);

                if (results.length > 0) return results;
            } catch (e: any) {
                attempts.push(`DDG ${variant.label} (${proxyName}) hata: ${e?.name || ''} ${e?.message || String(e)}`);
            }
        }
    }

    return [];
}

// DDG /html/ sonuç yapısı: <a class="result__a" href="...">başlık</a> ... <a class="result__snippet">açıklama</a>
function parseDdgHtml(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles = [...html.matchAll(titleRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    titles.forEach((m, i) => {
        const rawUrl = decodeHtmlEntities(m[1]);
        const url = extractDdgRealUrl(rawUrl);
        const title = stripHtml(m[2]);
        const snippet = snippets[i] ? stripHtml(snippets[i][1]) : 'Açıklama mevcut değil.';
        if (title && url && url.startsWith('http')) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

// DDG /lite/ basit tablo yapısı: <a class="result-link" href="...">başlık</a>, <td class="result-snippet">
function parseDdgLite(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const titleRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

    const titles = [...html.matchAll(titleRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    titles.forEach((m, i) => {
        const rawUrl = decodeHtmlEntities(m[1]);
        const url = extractDdgRealUrl(rawUrl);
        const title = stripHtml(m[2]);
        const snippet = snippets[i] ? stripHtml(snippets[i][1]) : 'Açıklama mevcut değil.';
        if (title && url && url.startsWith('http')) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

// DDG linkleri "//duckduckgo.com/l/?uddg=<gerçek-url>&..." şeklinde redirect ediyor
function extractDdgRealUrl(href: string): string {
    try {
        const full = href.startsWith('//') ? `https:${href}` : href;
        const u = new URL(full);
        const uddg = u.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
        return full;
    } catch (e) {
        return href;
    }
}

// ================= Yahoo — yedek kaynak =================
function buildYahooUrl(params: SearchParams): string {
    const usp = new URLSearchParams({ p: params.q });
    if (params.pageno > 1) usp.set('b', String((params.pageno - 1) * 10 + 1));
    return `https://search.yahoo.com/search?${usp.toString()}`;
}

async function fetchYahooWithProxies(params: SearchParams, attempts: string[]): Promise<SearchResult[]> {
    const targetUrl = buildYahooUrl(params);
    const deadline = Date.now() + 8000; // kalan bütçe

    for (const proxyName of PROXY_NAMES) {
        if (Date.now() > deadline) return [];
        try {
            const fetchUrl = wrapWithProxy(targetUrl, proxyName);
            const headers = proxyName === 'doğrudan'
                ? browserHeaders({ 'Referer': 'https://www.yahoo.com/', 'Cookie': 'A1=d=AQABBA; GUC=AQABAQFo; consent=1' })
                : browserHeaders();

            const response = await fetchWithTimeout(fetchUrl, headers, 4000);

            if (!response.ok) {
                attempts.push(`Yahoo (${proxyName}) hata: HTTP ${response.status}`);
                continue;
            }

            const html = await response.text();
            const results = parseYahooHtml(html);
            attempts.push(`Yahoo (${proxyName}): ${results.length} sonuç (uzunluk: ${html.length})`);

            if (results.length > 0) return results;
        } catch (e: any) {
            attempts.push(`Yahoo (${proxyName}) hata: ${e?.name || ''} ${e?.message || String(e)}`);
        }
    }

    return [];
}

function parseYahooHtml(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    const linkRegex = /<a[^>]+href="(https?:\/\/r\.search\.yahoo\.com\/[^"]*\/RU=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(html)) !== null) {
        const rawHref = decodeHtmlEntities(match[1]);
        const rawTitle = stripHtml(match[2]);
        const url = extractYahooRealUrl(rawHref);

        if (!url || !url.startsWith('http') || !rawTitle) continue;
        if (seen.has(url)) continue;

        const afterLink = html.slice(match.index + match[0].length, match.index + match[0].length + 800);
        const snippetMatch = afterLink.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';

        seen.add(url);
        results.push({ title: rawTitle, url, snippet });
    }

    return results;
}

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
