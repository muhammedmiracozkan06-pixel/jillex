import fetch from 'node-fetch';

export default async function handler(req, res) {
    // CORS Başlıklarını Ayarla (Ön yüzün güvenle erişebilmesi için)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: 'Sorgu parametresi (q) eksik.' });
    }

    try {
        const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`Arama motoru yanıt vermedi: ${response.status}`);
        }

        const htmlText = await response.text();
        const results = [];

        // Sunucu tarafında Regex ile HTML etiketlerini güvenli ve hızlıca ayıklıyoruz
        const resultRegex = /<div class="[^"]*links_main[^"]*">[\s\S]*?<a class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span class="result__snippet">([\s\S]*?)<\/span>/g;
        let match;

        while ((match = resultRegex.exec(htmlText)) !== null) {
            let rawUrl = match[1];
            let title = match[2].replace(/<[^>]*>/g, '').trim();
            let snippet = match[3].replace(/<[^>]*>/g, '').trim();

            // DuckDuckGo yönlendirme linklerini temizleme
            if (rawUrl.includes('uddg=')) {
                rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
            }

            results.push({ title, url: rawUrl, snippet });
        }

        // Eğer DuckDuckGo boş döndüyse Wikipedia yedek mekanizmasını sunucu tarafında çalıştır
        if (results.length === 0) {
            const wikiUrl = `https://tr.wikipedia.org/w/api.php?action=opensearch&format=json&search=${encodeURIComponent(q)}`;
            const wikiRes = await fetch(wikiUrl);
            const wikiData = await wikiRes.json();
            
            const titles = wikiData[1] || [];
            const descriptions = wikiData[2] || [];
            const links = wikiData[3] || [];

            for (let i = 0; i < titles.length; i++) {
                results.push({
                    title: titles[i],
                    url: links[i],
                    snippet: descriptions[i] || `${titles[i]} hakkında bilgi.`
                });
            }
        }

        return res.status(200).json(results);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
