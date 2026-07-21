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

    // category: general | images | news
    const category = ['general', 'images', 'news'].includes(req.query.category) ? req.query.category : 'general';
    // lang: SearXNG dil kodu, boş/all ise filtre uygulanmaz
    const lang = (req.query.lang && req.query.lang !== 'all') ? req.query.lang : 'all';
    // pageno: "diğer sonuçlar" (daha fazla yükle) butonu için sayfa numarası
    const pageno = Math.max(1, parseInt(req.query.pageno, 10) || 1);

    // NOT: search.ctq.ro'nun kendi ürettiği tüm dahili linkler (Preferences, About, stats)
    // "/searxng" alt yolu ile başlıyor (ör. https://search.ctq.ro/searxng/preferences).
    // Yani instance'ın base_url'i kökte değil, /searxng altında yapılandırılmış.
    // Bu yüzden hem /searxng önekli hem de önek olmadan deniyoruz; hangisi çalışırsa o kullanılıyor.
    const SEARX_BASES = ['https://search.ctq.ro/searxng', 'https://search.ctq.ro'];
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

    const params = { q, category, lang, pageno };

    try {
        let results = [];

        for (const base of SEARX_BASES) {
            try {
                results = await fetchSearxJson(base, params, UA);
                if (results.length > 0) break;
            } catch (e) {
                console.warn(`[JILLEX] (${base}) SearXNG JSON başarısız:`, e.message);
            }

            try {
                results = await fetchSearxHtml(base, params, UA);
                if (results.length > 0) break;
            } catch (e) {
                console.warn(`[JILLEX] (${base}) SearXNG HTML kazıma başarısız:`, e.message);
            }
        }

        // Görsel/haber kategorilerinde Wikipedia anlamlı bir yedek değil, sadece genel aramada kullan
        if (results.length === 0 && category === 'general' && pageno === 1) {
            await fetchWikipediaFallback(q, results);
        }

        return res.status(200).json(results);

    } catch (error) {
        console.error("[JILLEX SERVER ERROR]:", error.message);

        const fallbackResults = [];
        if (category === 'general' && pageno === 1) {
            try {
                await fetchWikipediaFallback(q, fallbackResults);
            } catch (e) {}
        }

        return res.status(200).json(fallbackResults);
    }
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

// JSON API dener (format=json etkinse çalışır, çoğu public instance'ta kapalıdır)
async function fetchSearxJson(base, params, userAgent) {
    const targetUrl = buildSearxUrl(base, params, { format: 'json' });
    const response = await fetch(targetUrl, { headers: { 'User-Agent': userAgent } });
    console.log(`[JILLEX] JSON dene: ${targetUrl} -> HTTP ${response.status}`);

    if (!response.ok) {
        throw new Error(`SearXNG JSON yanıt vermedi: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error(`SearXNG JSON döndürmedi, content-type: ${contentType}`);
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
}

// SearXNG'in normal (HTML) arama sonuç sayfasını kazır.
// JSON formatı kapalı olan instance'lar için güvenilir yedek yöntem.
async function fetchSearxHtml(base, params, userAgent) {
    const targetUrl = buildSearxUrl(base, params, {});
    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html'
        }
    });
    console.log(`[JILLEX] HTML dene: ${targetUrl} -> HTTP ${response.status}`);

    if (!response.ok) {
        throw new Error(`SearXNG HTML yanıt vermedi: ${response.status}`);
    }

    const html = await response.text();
    const results = [];

    // Her sonuç bir <article class="result ..."> bloğu içinde gelir (genel/haber/görsel hepsi için ortak).
    const articleRegex = /<article[^>]*class="result[^"]*"[\s\S]*?<\/article>/g;
    const articles = html.match(articleRegex) || [];
    console.log(`[JILLEX] HTML kazımada ${articles.length} <article class="result"> bloğu bulundu`);

    for (const block of articles) {
        const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkMatch) continue;

        const url = decodeHtmlEntities(linkMatch[1]);
        if (!url || !url.startsWith('http')) continue;

        if (params.category === 'images') {
            // Görsel sonuçlarında <a> içeriği metin değil <img> etiketidir; başlığı img alt'ından al.
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

// Ortak yedek arama fonksiyonu (sadece genel kategori + ilk sayfa için kullanılır)
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
