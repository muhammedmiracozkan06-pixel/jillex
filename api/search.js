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

    try {
        // Belirttiğin SearXNG örneğini JSON formatında sorguluyoruz
        const targetUrl = `https://search.ctq.ro/search?q=${encodeURIComponent(q)}&format=json`;
        
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`SearXNG yanıt vermedi: ${response.status}`);
        }

        const data = await response.json();
        const results = [];

        // SearXNG'den dönen 'results' dizisini mapliyoruz
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

        // Eğer SearXNG anlık boş dönerse yedek plan (Wikipedia) devreye girsin
        if (results.length === 0) {
            await fetchWikipediaFallback(q, results);
        }

        return res.status(200).json(results);

    } catch (error) {
        console.error("[JILLEX SERVER ERROR]:", error.message);
        
        // Hata durumunda da sistemi çökertmiyoruz, Wikipedia'dan şansımızı deniyoruz
        const fallbackResults = [];
        try {
            await fetchWikipediaFallback(q, fallbackResults);
        } catch (e) {}
        
        return res.status(200).json(fallbackResults);
    }
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
