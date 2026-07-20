import * as cheerio from 'cheerio';

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

    try {
        const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });

        const results = [];

        if (response.ok) {
            const htmlText = await response.text();
            
            // Cheerio ile HTML'i DOM ağacı gibi güvenle tarıyoruz
            const $ = cheerio.load(htmlText);
            
            $('.links_main').each((i, element) => {
                const titleElement = $(element).find('.result__a');
                // Snippet bir sonraki kardeş elementte (result__snippet) yer alır
                const snippetElement = $(element).next('.result__snippet');

                if (titleElement.length > 0) {
                    const title = titleElement.text().trim();
                    let rawUrl = titleElement.attr('href') || '';
                    const snippet = snippetElement.length > 0 ? snippetElement.text().trim() : "Açıklama mevcut değil.";

                    if (rawUrl.includes('uddg=')) {
                        rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
                    }

                    if (title && rawUrl) {
                        results.push({ title, url: rawUrl, snippet });
                    }
                }
            });
        }

        // Arama motoru boş dönerse Wikipedia yedek planı
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

        return res.status(200).json(results);

    } catch (error) {
        console.error("[JILLEX SERVER ERROR]:", error.message);
        return res.status(200).json([]); // Hata anında bile 500 basma, boş dizi dön ki frontend çökmesin
    }
}
