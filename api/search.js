// api/search.js
export default async function handler(req, res) {
    // CORS Başlıkları
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Preflight istekleri için 200 OK dönüyoruz
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { q } = req.query;
    if (!q) {
        return res.status(200).json([]);
    }

    const SEARX_BASE = 'https://search.ctq.ro';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

    try {
        let results = [];

        // 1. Önce JSON formatını dene (instance destekliyorsa en temizi budur)
        try {
            results = await fetchSearxJson(SEARX_BASE, q, UA);
        } catch (e) {
            console.warn("[JILLEX] SearXNG JSON başarısız, HTML'e düşülüyor:", e.message);
        }

        // 2. JSON boş/başarısız olduysa SearXNG'in normal HTML sayfasını kazı
        //    (format kısıtlaması olmadığı için neredeyse her instance'da çalışır)
        if (results.length === 0) {
            try {
                results = await fetchSearxHtml(SEARX_BASE, q, UA);
            } catch (e) {
                console.warn("[JILLEX] SearXNG HTML kazıma başarısız:", e.message);
            }
        }

        // 3. O da olmazsa, son çare olarak Wikipedia
        if (results.length === 0) {
            await fetchWikipediaFallback(q, results);
        }

        return res.status(200).json(results);

    } catch (error) {
        console.error("[JILLEX SERVER ERROR]:", error.message);

        const fallbackResults = [];
        try {
            await fetchWikipediaFallback(q, fallbackResults);
        } catch (e) {}

        return res.status(200).json(fallbackResults);
    }
}

// JSON API dener (format=json etkinse çalışır, çoğu public instance'ta kapalıdır)
async function fetchSearxJson(base, q, userAgent) {
    const targetUrl = `${base}/search?q=${encodeURIComponent(q)}&format=json`;
    const response = await fetch(targetUrl, { headers: { 'User-Agent': userAgent } });

    if (!response.ok) {
        throw new Error(`SearXNG JSON yanıt vermedi: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        // Bazı instance'lar 200 dönüp aslında HTML sayfası gönderir (format desteklenmiyordur)
        throw new Error('SearXNG JSON döndürmedi (muhtemelen format=json kapalı)');
    }

    const data = await response.json();
    const results = [];
    if (data.results && Array.isArray(data.results)) {
        data.results.forEach(item => {
            if (item.title && item.url) {
                results.push({
                    title: item.title,
                    url: item.url,
                    snippet: item.content || "Açıklama mevcut değil."
                });
            }
        });
    }
    return results;
}

// SearXNG'in normal (HTML) arama sonuç sayfasını kazır.
// JSON formatı kapalı olan instance'lar için güvenilir yedek yöntem.
async function fetchSearxHtml(base, q, userAgent) {
    const targetUrl = `${base}/search?q=${encodeURIComponent(q)}`;
    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html'
        }
    });

    if (!response.ok) {
        throw new Error(`SearXNG HTML yanıt vermedi: ${response.status}`);
    }

    const html = await response.text();
    const results = [];

    // Her sonuç bir <article class="result ..."> bloğu içinde gelir.
    const articleRegex = /<article[^>]*class="result[^"]*"[\s\S]*?<\/article>/g;
    const articles = html.match(articleRegex) || [];

    for (const block of articles) {
        const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/<p[^>]*class="content[^"]*"[^>]*>([\s\S]*?)<\/p>/);

        if (linkMatch) {
            const url = decodeHtmlEntities(linkMatch[1]);
            const title = stripHtml(linkMatch[2]);
            const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "Açıklama mevcut değil.";

            if (title && url && url.startsWith('http')) {
                results.push({ title, url, snippet });
            }
        }
    }

    return results;
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

// Ortak yedek arama fonksiyonu
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
