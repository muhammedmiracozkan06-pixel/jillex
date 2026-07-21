// api/search.js
export default async function handler(req, res) {
    // CORS Başlıkları
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { q } = req.query;
    if (!q) {
        return res.status(200).json([]);
    }

    const category = ['general', 'images', 'news'].includes(req.query.category) ? req.query.category : 'general';
    const lang = (req.query.lang && req.query.lang !== 'all') ? req.query.lang : 'all';
    const pageno = Math.max(1, parseInt(req.query.pageno, 10) || 1);
    const params = { q, category, lang, pageno };

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    const attempts = [];

    try {
        let results = [];

        // ================= 1. ANA KAYNAK: DuckDuckGo (HTML) =================
        // Tek, büyük ve genelde stabil bir servis olduğu için ana kaynak burası.
        // Not: DDG'nin "html" arayüzü sadece genel (web) arama sunuyor;
        // görsel/haber kategorileri için doğrudan SearXNG havuzuna geçiyoruz.
        if (category === 'general') {
            try {
                results = await withTimeout(fetchDuckDuckGoHtml(params, UA), 5000);
                attempts.push(`DuckDuckGo HTML: ${results.length} sonuç`);
            } catch (e) {
                attempts.push(`DuckDuckGo HTML hata: ${e.message}`);
            }
        }

        // ================= 2. YEDEK: SearXNG instance havuzu =================
        if (results.length === 0) {
            results = await trySearxPool(params, UA, attempts);
        }

        // ================= 3. SON ÇARE: Wikipedia =================
        // Sadece genel kategori + ilk sayfa için anlamlı bir yedek.
        if (results.length === 0 && category === 'general' && pageno === 1) {
            await fetchWikipediaFallback(q, results);
            attempts.push(`Wikipedia yedek: ${results.length} sonuç`);
        }

        console.log(`[JILLEX] "${q}" (${category}) denemeleri:\n - ${attempts.join('\n - ')}`);
        return res.status(200).json(results);

    } catch (error) {
        console.error("[JILLEX SERVER ERROR]:", error.message, attempts);

        const fallbackResults = [];
        if (category === 'general' && pageno === 1) {
            try {
                await fetchWikipediaFallback(q, fallbackResults);
            } catch (e) {}
        }
        return res.status(200).json(fallbackResults);
    }
}

// ================= DuckDuckGo (HTML) — ana kaynak =================
function fetchDuckDuckGoHtml(params, userAgent) {
    return async (signal) => {
        const KL_MAP = { tr: 'tr-tr', en: 'us-en', de: 'de-de', fr: 'fr-fr', es: 'es-es' };
        const usp = new URLSearchParams({ q: params.q });
        if (KL_MAP[params.lang]) usp.set('kl', KL_MAP[params.lang]);
        if (params.pageno > 1) usp.set('s', String((params.pageno - 1) * 30));

        const response = await fetch(`https://html.duckduckgo.com/html/?${usp.toString()}`, {
            method: 'GET',
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            signal
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();
        const results = [];

        // Her sonuç: <a class="result__a" href="...">Başlık</a> ... <a class="result__snippet" ...>Açıklama</a>
        const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

        const titles = [...html.matchAll(titleRegex)];
        const snippets = [...html.matchAll(snippetRegex)];

        titles.forEach((m, i) => {
            const rawUrl = decodeHtmlEntities(m[1]);
            const url = extractRealUrl(rawUrl);
            const title = stripHtml(m[2]);
            const snippet = snippets[i] ? stripHtml(snippets[i][1]) : "Açıklama mevcut değil.";
            if (title && url && url.startsWith('http')) {
                results.push({ title, url, snippet });
            }
        });

        return results;
    };
}

// DDG bağlantıları yönlendirme üzerinden gelir: //duckduckgo.com/l/?uddg=GERÇEK_URL&...
function extractRealUrl(href) {
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

// ================= SearXNG instance havuzu — yedek kaynak =================
async function trySearxPool(params, userAgent, attempts) {
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
    const pool = [INSTANCE_POOL[0], ...shuffle(INSTANCE_POOL.slice(1))];

    let results = [];
    for (const base of pool) {
        try {
            results = await withTimeout(fetchSearxJson(base, params, userAgent), 3000);
            attempts.push(`${base} JSON: ${results.length} sonuç`);
            if (results.length > 0) return results;
        } catch (e) {
            attempts.push(`${base} JSON hata: ${e.message}`);
        }

        try {
            results = await withTimeout(fetchSearxHtml(base, params, userAgent), 4000);
            attempts.push(`${base} HTML: ${results.length} sonuç`);
            if (results.length > 0) return results;
        } catch (e) {
            attempts.push(`${base} HTML hata: ${e.message}`);
        }
    }
    return results;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function withTimeout(taskFn, ms) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    return Promise.race([
        taskFn(controller.signal).finally(() => clearTimeout(timeout)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('zaman aşımı')), ms + 200))
    ]);
}

function buildSearxUrl(base, params, extra) {
    const usp = new URLSearchParams({
        q: params.q,
        pageno: String(params.pageno),
        ...extra
    });
    if (params.category !== 'general') usp.set('categories', params.category);
    if (params.lang !== 'all') usp.set('language', params.lang);
    return `${base}/search?${usp.toString()}`;
}

function fetchSearxJson(base, params, userAgent) {
    return async (signal) => {
        const targetUrl = buildSearxUrl(base, params, { format: 'json' });
        const response = await fetch(targetUrl, { headers: { 'User-Agent': userAgent }, signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error(`JSON değil (content-type: ${contentType})`);
        }

        const data = await response.json();
        const results = [];
        if (data.results && Array.isArray(data.results)) {
            data.results.forEach(item => {
                if (!item.title || !item.url) return;
                const result = {
                    title: item.title,
                    url: item.url,
                    snippet: item.content || "Açıklama mevcut değil."
                };
                if (params.category === 'images') {
                    const img = item.img_src || item.thumbnail_src || item.thumbnail;
                    if (img) result.image = resolveUrl(img, base);
                }
                results.push(result);
            });
        }
        return results;
    };
}

function fetchSearxHtml(base, params, userAgent) {
    return async (signal) => {
        const targetUrl = buildSearxUrl(base, params, {});
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': userAgent, 'Accept': 'text/html' },
            signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();
        const results = [];

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
                const image = imgMatch ? resolveUrl(decodeHtmlEntities(imgMatch[1]), base) : null;
                results.push({ title, url, snippet: '', image });
            } else {
                const snippetMatch = block.match(/<p[^>]*class="content[^"]*"[^>]*>([\s\S]*?)<\/p>/);
                const title = stripHtml(linkMatch[2]);
                const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "Açıklama mevcut değil.";
                if (title) results.push({ title, url, snippet });
            }
        }
        return results;
    };
}

function resolveUrl(maybeRelative, base) {
    try {
        return new URL(maybeRelative, base + '/').href;
    } catch (e) {
        return maybeRelative;
    }
}

function stripHtml(str) {
    return decodeHtmlEntities(str.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

// ================= WIKIPEDIA — en son çare =================
async function fetchWikipediaFallback(query, arrayToPush) {
    const wikiUrl = `https://tr.wikipedia.org/w/api.php?action=opensearch&format=json&search=${encodeURIComponent(query)}`;
    const wikiRes = await fetch(wikiUrl);
    if (wikiRes.ok) {
        const wikiData = await wikiRes.json();
        const titles = wikiData[1] || [];
        const descriptions = wikiData[2] || [];
        const links = wikiData[3] || [];

        for (let i = 0; i < titles.length; i++) {
            arrayToPush.push({
                title: titles[i],
                url: links[i],
                snippet: descriptions[i] || `${titles[i]} hakkında bilgi.`
            });
        }
    }
}
