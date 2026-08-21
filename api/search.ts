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

        // ================= AŞAMA 1: Tüm HTML motorları paralel yarış =================
        if (category === 'general') {
            results = await raceFirstNonEmpty(
                [
                    { name: 'Yahoo HTML', run: (signal) => fetchYahooHtml(params, signal) },
                    { name: 'Bing HTML', run: (signal) => fetchBingHtml(params, signal) },
                    { name: 'DuckDuckGo Lite', run: (signal) => fetchDuckDuckGoLite(params, signal) },
                    { name: 'Google HTML', run: (signal) => fetchGoogleHtml(params, signal) },
                    { name: 'Mojeek', run: (signal) => fetchMojeekHtml(params, signal) },
                ],
                5000,
                attempts
            );
        }

        // ================= AŞAMA 2: SearXNG havuzu (paralel yarış) =================
        if (results.length === 0) {
            results = await trySearxPoolParallel(params, attempts);
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

// ================= Paralel yarış yardımcı fonksiyonu =================
interface RaceTask {
    name: string;
    run: (signal: AbortSignal) => Promise<SearchResult[]>;
}

function raceFirstNonEmpty(tasks: RaceTask[], timeoutMs: number, attempts: string[]): Promise<SearchResult[]> {
    return new Promise((resolve) => {
        if (tasks.length === 0) {
            resolve([]);
            return;
        }

        let settledCount = 0;
        let resolved = false;
        const controllers: AbortController[] = [];

        const finishIfDone = () => {
            if (!resolved && settledCount === tasks.length) {
                resolved = true;
                resolve([]);
            }
        };

        tasks.forEach(({ name, run }) => {
            const controller = new AbortController();
            controllers.push(controller);
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            run(controller.signal)
                .then((taskResults) => {
                    clearTimeout(timer);
                    attempts.push(`${name}: ${taskResults.length} sonuç`);
                    settledCount++;
                    if (!resolved && taskResults.length > 0) {
                        resolved = true;
                        controllers.forEach((c) => c.abort());
                        resolve(taskResults);
                    } else {
                        finishIfDone();
                    }
                })
                .catch((e: any) => {
                    clearTimeout(timer);
                    attempts.push(`${name} hata: ${e?.message || String(e)}`);
                    settledCount++;
                    finishIfDone();
                });
        });
    });
}

// ================= Yahoo (HTML) =================
async function fetchYahooHtml(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const usp = new URLSearchParams({ p: params.q });
    if (params.pageno > 1) usp.set('b', String((params.pageno - 1) * 10 + 1));

    const response = await fetch(`https://search.yahoo.com/search?${usp.toString()}`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html',
            'Cookie': 'A1=; consent=1' // consent duvarını atlamayı dener
        },
        signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    // Yahoo sonuç blokları: <div class="algo-sr"> ... </div> veya <li class="algo-sr">
    const blockRegex = /<div[^>]*class="[^"]*\balgo\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*\balgo\b[^"]*"|<div[^>]*id="web"|$)/g;
    const blocks = html.match(blockRegex) || [];

    for (const block of blocks) {
        const linkMatch = block.match(/<a[^>]*class="[^"]*d-ib[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
            || block.match(/<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkMatch) continue;

        const rawUrl = decodeHtmlEntities(linkMatch[1]);
        const url = extractYahooRealUrl(rawUrl);
        const title = stripHtml(linkMatch[2]);
        if (!title || !url || !url.startsWith('http')) continue;

        const snippetMatch = block.match(/<p[^>]*class="[^"]*fz-ms[^"]*"[^>]*>([\s\S]*?)<\/p>/)
            || block.match(/<div[^>]*class="[^"]*compText[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';
        results.push({ title, url, snippet });
    }

    return results;
}

// Yahoo linkleri r.search.yahoo.com üzerinden redirect ediyor, gerçek URL "RU=" içinde
function extractYahooRealUrl(href: string): string {
    try {
        if (href.includes('r.search.yahoo.com') || href.includes('/RU=')) {
            const match = href.match(/\/RU=([^/]+)\//);
            if (match) return decodeURIComponent(match[1]);
        }
        return href;
    } catch (e) {
        return href;
    }
}

// ================= Bing (HTML) =================
async function fetchBingHtml(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const CC_MAP: Record<string, string> = { tr: 'tr-TR', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES' };
    const usp = new URLSearchParams({ q: params.q });
    if (params.pageno > 1) usp.set('first', String((params.pageno - 1) * 10 + 1));

    const response = await fetch(`https://www.bing.com/search?${usp.toString()}`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html',
            'Accept-Language': CC_MAP[params.lang] || 'en-US'
        },
        signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    // Bing sonuçları <li class="b_algo"> ... </li> blokları içinde
    const blockRegex = /<li[^>]*class="b_algo"[^>]*>[\s\S]*?<\/li>/g;
    const blocks = html.match(blockRegex) || [];

    for (const block of blocks) {
        const linkMatch = block.match(/<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
        if (!linkMatch) continue;
        const url = decodeHtmlEntities(linkMatch[1]);
        const title = stripHtml(linkMatch[2]);
        if (!title || !url || !url.startsWith('http')) continue;
        const snippetMatch = block.match(/<p>([\s\S]*?)<\/p>/) || block.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';
        results.push({ title, url, snippet });
    }

    return results;
}

// ================= DuckDuckGo Lite (HTML) =================
async function fetchDuckDuckGoLite(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const KL_MAP: Record<string, string> = { tr: 'tr-tr', en: 'us-en', de: 'de-de', fr: 'fr-fr', es: 'es-es' };
    const usp = new URLSearchParams({ q: params.q });
    if (KL_MAP[params.lang]) usp.set('kl', KL_MAP[params.lang]);
    if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 30));

    const response = await fetch(`https://lite.duckduckgo.com/lite/?${usp.toString()}`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    // Lite sürüm basit tablo yapısı: <a class="result-link" href="...">title</a> ve sonrasında <td class="result-snippet">
    const titleRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

    const titles = [...html.matchAll(titleRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    titles.forEach((m, i) => {
        const rawUrl = decodeHtmlEntities(m[1]);
        const url = extractRealUrl(rawUrl);
        const title = stripHtml(m[2]);
        const snippet = snippets[i] ? stripHtml(snippets[i][1]) : 'Açıklama mevcut değil.';
        if (title && url && url.startsWith('http')) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

function extractRealUrl(href: string): string {
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

// ================= Google (HTML) =================
async function fetchGoogleHtml(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const HL_MAP: Record<string, string> = { tr: 'tr', en: 'en', de: 'de', fr: 'fr', es: 'es' };
    const usp = new URLSearchParams({ q: params.q, num: '10' });
    if (HL_MAP[params.lang]) usp.set('hl', HL_MAP[params.lang]);
    if (params.pageno > 1) usp.set('start', String((params.pageno - 1) * 10));

    const response = await fetch(`https://www.google.com/search?${usp.toString()}`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html',
            'Accept-Language': HL_MAP[params.lang] || 'en'
        },
        signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    // Google sonuç blokları: <div class="g"> ... </div> (yapı sık değişir, tolerant regex)
    const blockRegex = /<div[^>]*class="[^"]*\bg\b[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*\bg\b[^"]*"|$)/g;
    const blocks = html.match(blockRegex) || [];

    for (const block of blocks) {
        const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/);
        if (!linkMatch) continue;
        const url = decodeHtmlEntities(linkMatch[1]);
        const title = stripHtml(linkMatch[2]);
        if (!title || !url) continue;
        const snippetMatch = block.match(/<div[^>]*(?:data-sncf|class="[^"]*VwiC3b[^"]*")[^>]*>([\s\S]*?)<\/div>/);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';
        results.push({ title, url, snippet });
    }

    return results;
}

// ================= Mojeek (HTML) =================
async function fetchMojeekHtml(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const LANG_MAP: Record<string, string> = { tr: 'tr', en: 'en', de: 'de', fr: 'fr', es: 'es' };
    const usp = new URLSearchParams({ q: params.q });
    if (LANG_MAP[params.lang]) usp.set('lb', LANG_MAP[params.lang]);
    if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 10 + 1));

    const response = await fetch(`https://www.mojeek.com/search?${usp.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    const titleRegex = /<a[^>]*class="ob"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/g;

    const titles = [...html.matchAll(titleRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    titles.forEach((m, i) => {
        const url = decodeHtmlEntities(m[1]);
        const title = stripHtml(m[2]);
        const snippet = snippets[i] ? stripHtml(snippets[i][1]) : 'Açıklama mevcut değil.';
        if (title && url && url.startsWith('http')) {
            results.push({ title, url, snippet });
        }
    });

    return results;
}

// ================= SearXNG instance havuzu — paralel =================
const INSTANCE_POOL = [
    'https://searxng-jillex.onrender.com', // Senin kendi instance'ın (en öncelikli)
    'https://search.ctq.ro/searxng',
    'https://search.ctq.ro',
    'https://priv.au',
    'https://opnxng.com',
    'https://baresearch.org',
    'https://etsi.me',
    'https://ooglester.com',
    'https://search.2b9t.xyz',
    'https://sear.lurx.net'
];

async function trySearxPoolParallel(params: SearchParams, attempts: string[]): Promise<SearchResult[]> {
    // AŞAMA 2a: Önce SADECE kendi instance'ını dene, cold-start'a bütçe tanıyarak (uzun timeout).
    // Bu sayede Render'ın uyanması bekleniyor ve düşük kaliteli public havuza düşülmüyor.
    const primary = INSTANCE_POOL[0];
    const primaryTasks: RaceTask[] = [
        { name: `${primary} JSON`, run: (signal) => fetchSearxJson(primary, params, signal) },
        { name: `${primary} HTML`, run: (signal) => fetchSearxHtml(primary, params, signal) },
    ];
    const primaryResults = await raceFirstNonEmpty(primaryTasks, 25000, attempts);
    if (primaryResults.length > 0) return primaryResults;

    // AŞAMA 2b: Kendi instance başarısız/boşsa geri kalan havuza düş.
    const restPool = INSTANCE_POOL.slice(1);
    const tasks: RaceTask[] = [];
    for (const base of restPool) {
        tasks.push({ name: `${base} JSON`, run: (signal) => fetchSearxJson(base, params, signal) });
        tasks.push({ name: `${base} HTML`, run: (signal) => fetchSearxHtml(base, params, signal) });
    }
    return raceFirstNonEmpty(tasks, 6000, attempts);
}

function buildSearxUrl(base: string, params: SearchParams, extra: Record<string, string>): string {
    const usp = new URLSearchParams({
        q: params.q,
        pageno: String(params.pageno),
        ...extra
    });
    if (params.category !== 'general') usp.set('categories', params.category);
    if (params.lang !== 'all') usp.set('language', params.lang);
    return `${base}/search?${usp.toString()}`;
}

async function fetchSearxJson(base: string, params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const targetUrl = buildSearxUrl(base, params, { format: 'json' });
    const response = await fetch(targetUrl, { headers: { 'User-Agent': UA }, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error(`JSON değil (content-type: ${contentType})`);
    }

    const data = await response.json();
    const results: SearchResult[] = [];
    if (data.results && Array.isArray(data.results)) {
        data.results.forEach((item: any) => {
            if (!item.title || !item.url) return;
            const result: SearchResult = {
                title: item.title,
                url: item.url,
                snippet: item.content || 'Açıklama mevcut değil.'
            };
            if (params.category === 'images') {
                const img = item.img_src || item.thumbnail_src || item.thumbnail;
                if (img) result.image = resolveUrl(img, base);
            }
            results.push(result);
        });
    }
    return results;
}

async function fetchSearxHtml(base: string, params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const targetUrl = buildSearxUrl(base, params, {});
    const response = await fetch(targetUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const results: SearchResult[] = [];

    const articleRegex = /<article[^>]*class="result[^"]*"[\s\S]*?<\/article>/g;
    const articles = html.match(articleRegex) || [];

    for (const block of articles) {
        const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkMatch) continue;

        const url = decodeHtmlEntities(linkMatch[1]);
        if (!url || !url.startsWith('http')) continue;

        if (params.category === 'images') {
            const imgMatch = block.match(/<img[^>]*src="([^"]+)"[^>]*(?:alt="([^"]*)")?/);
            const altMatch = block.match(/alt="([^"]*)"/);
            const title = stripHtml((altMatch && altMatch[1]) || (imgMatch && imgMatch[2]) || '') || 'Görsel';
            const image = imgMatch ? resolveUrl(decodeHtmlEntities(imgMatch[1]), base) : undefined;
            results.push({ title, url, snippet: '', image });
        } else {
            const snippetMatch = block.match(/<p[^>]*class="content[^"]*"[^>]*>([\s\S]*?)<\/p>/);
            const title = stripHtml(linkMatch[2]);
            const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : 'Açıklama mevcut değil.';
            if (title) results.push({ title, url, snippet });
        }
    }
    return results;
}

function resolveUrl(maybeRelative: string, base: string): string {
    try {
        return new URL(maybeRelative, base + '/').href;
    } catch (e) {
        return maybeRelative;
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
