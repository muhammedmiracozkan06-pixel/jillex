// api/search.js
export default async function handler(req, res) {
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

    // Vercel'in patlamasını önleyen, şu an en hızlı ve kararlı çalışan aktif SearXNG havuzları
    const fastNodes = [
        'https://search.mdcnet.de/search',
        'https://searx.netzspielplatz.de/search',
        'https://searx.perennialte.ch/search',
        'https://searxng.site/search'
    ];

    // Eğer kullanıcı alttan Searx seçtiyse alternatif listeyi kullan
    const targetBaseUrl = engine === 'Searx' ? fastNodes[1] : fastNodes[0];
    const targetUrl = `${targetBaseUrl}?q=${encodeURIComponent(q)}&categories=${categories || 'general'}&language=${language || 'tr-TR'}&format=json`;

    try {
        // Vercel'e bu isteği en fazla 8 saniye beklemesini söylüyoruz, yoksa diğer node'a geçebiliriz
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Status ${response.status}`);
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        // İlk node hata verirse B planı olarak en kararlı 2. yedek node'a anında istek atıyoruz
        try {
            const backupUrl = `${fastNodes[2]}?q=${encodeURIComponent(q)}&categories=${categories || 'general'}&language=${language || 'tr-TR'}&format=json`;
            const backupResponse = await fetch(backupUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (backupResponse.ok) {
                const backupData = await backupResponse.json();
                return res.status(200).json(backupData);
            }
        } catch (e) {}

        return res.status(500).json({ error: "Tüm arama sunucu havuzları meşgul, lütfen az sonra tekrar deneyin." });
    }
}
