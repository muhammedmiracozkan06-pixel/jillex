// api/search.js
// Vercel'in hata vermemesi için CommonJS (module.exports) yapısına geçtik
module.exports = async (req, res) => {
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
        return res.status(200).json([]); // Hata fırlatmak yerine boş dizi dönüyoruz (500'ü engellemek için)
    }

    try {
        const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        
        // Node'un yerleşik fetch'i ile istek atıyoruz
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });

        const results = [];

        if (response.ok) {
            const htmlText = await response.text();
            
            // Regex eşleşmelerini daha güvenli bir try-catch bloğuna alıyoruz
            try {
                const resultRegex = /<div class="[^"]*links_main[^"]*">[\s\S]*?<a class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span class="result__snippet">([\s\S]*?)<\/span>/g;
                let match;

                while ((match = resultRegex.exec(htmlText)) !== null) {
                    let rawUrl = match[1];
                    let title = match[2].replace(/<[^>]*>/g, '').trim();
                    let snippet = match[3].replace(/<[^>]*>/g, '').trim();

                    if (rawUrl.includes('uddg=')) {
                        rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
                    }

                    results.push({ title, url: rawUrl, snippet });
                }
            } catch (regexError) {
                console.error("Regex Hatası:", regexError);
            }
        }

        // Eğer DuckDuckGo sunucumuzu engellediyse veya sonuç bulamadıysa doğrudan Wikipedia fallback devreye girsin
        if (results.length === 0) {
            const wikiUrl = `https://tr.wikipedia.org/w/api.php?action=opensearch&format=json&search=${encodeURIComponent(q)}`;
            const wikiRes = await fetch(wikiUrl);
            
            if (wikiRes.ok) {
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
        }

        // Ne olursa olsun 200 OK dönüyoruz, böylece frontend 500 hatası alıp kırılmıyor
        return res.status(200).json(results);

    } catch (error) {
        console.error("Genel Sunucu Hatası:", error);
        // Hata durumunda bile boş dizi dönerek frontend tarafını ayakta tutuyoruz
        return res.status(200).json([]);
    }
};
