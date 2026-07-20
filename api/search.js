// api/search.js
export default async function handler(req, res) {
    // CORS Başlıkları
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { q, categories, language, engine } = req.query;

    if (!q) {
        return res.status(400).json({ error: "Query parameter 'q' is missing" });
    }

    // Kararlı çalışan genel arama node adresleri
    const targetBaseUrl = engine === 'Searx' 
        ? 'https://searx.space/search' 
        : 'https://searx.be/search';

    const targetUrl = `${targetBaseUrl}?q=${encodeURIComponent(q)}&categories=${categories || 'general'}&language=${language || 'tr-TR'}&format=json`;

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`Engine responded with status ${response.status}`);
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: "Search cluster connection failed", details: error.message });
    }
}
