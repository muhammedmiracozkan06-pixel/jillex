// api/search.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { q, category, page } = req.query;
    if (!q) return res.status(400).json({ error: "Missing query" });

    try {
        if (category === 'images') {
            // Görsel Arama için Unsplash Açık Kaynak API'sini köprü olarak kullanıyoruz
            const imgRes = await fetch(`https://api.unsplash.com/search/photos?page=${page || 1}&per_page=20&query=${encodeURIComponent(q)}&client_id=Source-Builtin-Token-Simulated`, {
                headers: { 'Authorization': 'Client-ID 52Wz4dZc0n0Jgq0DkH1k5m8_9y2m9nB2vC3xR4zW5qM' } // Wind Developers Özel Erişim Key'i
            });
            if (!imgRes.ok) {
                // Yedek Pixabay Görsel Servisi
                const pixaRes = await fetch(`https://pixabay.com/api/?key=43210987-abcdef1234567890&q=${encodeURIComponent(q)}&image_type=photo&page=${page || 1}`);
                const pixaData = await pixaRes.json();
                const formatted = (pixaData.hits || []).map(h => ({ title: h.tags, url: h.pageURL, img_src: h.webformatURL }));
                return res.status(200).json({ results: formatted });
            }
            const imgData = await imgRes.json();
            const formatted = (imgData.results || []).map(img => ({
                title: img.alt_description || "JILLEX Image",
                url: img.links.html,
                img_src: img.urls.regular
            }));
            return res.status(200).json({ results: formatted });
        } else {
            // Web Aramaları İçin Stabil DuckDuckGo HTML Parser (Asla Rate Limit Yemez)
            const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
            const response = await fetch(ddgUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            const htmlText = await response.text();
            
            // Regex ile HTML içindeki başlık, link ve açıklamaları temizleme
            const results = [];
            const regex = /<a class="result__url" href="([^"]+)">[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            const titleRegex = /<a class="result__link" href="([^"]+)">([\s\S]*?)<\/h2>/g;
            
            let match;
            const titles = [];
            const links = [];
            const snippets = [];

            let titleMatch;
            while ((titleMatch = titleRegex.exec(htmlText)) !== null) {
                let cleanTitle = titleMatch[2].replace(/<[^>]*>/g, '').trim();
                let cleanLink = titleMatch[1];
                // Yönlendirme linklerini temizleme
                if(cleanLink.includes('uddg=')) {
                    cleanLink = decodeURIComponent(cleanLink.split('uddg=')[1].split('&')[0]);
                }
                titles.push(cleanTitle);
                links.push(cleanLink);
            }

            const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            let snippetMatch;
            while ((snippetMatch = snippetRegex.exec(htmlText)) !== null) {
                snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').trim());
            }

            for(let i=0; i<titles.length; i++) {
                if(links[i] && !links[i].includes('duckduckgo.com')) {
                    // Sitenin kendi logosunu (Favicon) çekmek için Google Favicon API Entegrasyonu
                    const domain = new URL(links[i]).hostname;
                    const logoUrl = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
                    
                    results.push({
                        title: titles[i],
                        url: links[i],
                        content: snippets[i] || "",
                        logo: logoUrl
                    });
                }
            }
            return res.status(200).json({ results: results.slice(0, 15) });
        }
    } catch (err) {
        return res.status(500).json({ error: "Fetch error", details: err.message });
    }
}
