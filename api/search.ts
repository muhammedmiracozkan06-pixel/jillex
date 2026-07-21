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

        // ================= AŞAMA 1: DuckDuckGo + Mojeek (paralel yarış) =================
        // İkisi de sadece genel kategori destekliyor. Aynı anda başlatılır,
        // ilk boş olmayan sonuç kazanır, diğeri otomatik iptal edilir.
        if (category === 'general') {
            results = await raceFirstNonEmpty(
                [
                    { name: 'DuckDuckGo HTML', run: (signal) => fetchDuckDuckGoHtml(params, signal) },
                    { name: 'Mojeek', run: (signal) => fetchMojeekHtml(params, signal) },
                ],
                5000,
                attempts
            );
        }

        // ================= AŞAMA 2: SearXNG havuzu (paralel yarış) =================
        // Tüm instance'lar (JSON + HTML varyantları) aynı anda denenir.
        // Sıralı denemenin aksine, toplam bekleme süresi en yavaş değil en hızlı
        // kaynağa göre belirlenir.
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
// Verilen görevleri aynı anda başlatır. İlk boş olmayan sonucu döndüren
// görev "kazanır" ve diğer tüm görevler abort edilir. Hepsi boş/hatalı
// dönerse boş dizi döner.
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

// ================= DuckDuckGo (HTML) =================
async function fetchDuckDuckGoHtml(params: SearchParams, signal: AbortSignal): Promise<SearchResult[]> {
    const KL_MAP: Record<string, string> = { tr: 'tr-tr', en: 'us-en', de: 'de-de', fr: 'fr-fr', es: 'es-es' };
    const usp = new URLSearchParams({ q: params.q });
    if (KL_MAP[params.lang]) usp.set('kl', KL_MAP[params.lang]);
    if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 30));

    const response = await fetch(`https://html.duckduckgo.com/html/?${usp.toString()}`, {
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

    const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

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

// ================= Mojeek (HTML) — bağımsız index, key gerekmiyor =================
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
    const tasks: RaceTask[] = [];
    for (const base of INSTANCE_POOL) {
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
