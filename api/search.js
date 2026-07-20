// api/search.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { q, category, page } = req.query;
    if (!q) return res.status(400).json({ error: "Missing query" });

    const pageNumber = parseInt(page) || 1;

    try {
        // Dünyanın en kararlı, bot korumasız ve açık kaynaklı SearXNG JSON düğümü
        // Doğrudan tüm interneti (Google, Bing vb.) tarar ve sınırsızdır
        const targetCat = category === 'images' ? 'images' : 'general';
        const searchUrl = `https://search.mdcnet.de/search?q=${encodeURIComponent(q)}&categories=${targetCat}&format=json&pageno=${pageNumber}&language=tr-TR`;

        const response = await fetch(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JILLEX-Engine/5.0 (Wind Developers)'
            }
        });

        if (!response.ok) throw new Error("Central node response error");
        const data = await response.json();
        
        const finalResults = [];

        if (category === 'images') {
            if (data.results && data.results.length > 0) {
                data.results.forEach(item => {
                    if (item.img_src || item.thumbnail_src) {
                        finalResults.push({
                            title: item.title || "JILLEX Visual",
                            url: item.url || item.img_src,
                            img_src: item.img_src || item.thumbnail_src
                        });
                    }
                });
            }
        } else {
            if (data.results && data.results.length > 0) {
                data.results.forEach(item => {
                    if (item.url && item.title) {
                        let domain = "link";
                        try { domain = new URL(item.url).hostname; } catch(e){}

                        finalResults.push({
                            title: item.title,
                            url: item.url,
                            content: item.content || "Daha fazla bilgi için siteyi ziyaret edin.",
                            logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                        });
                    }
                });
            }
        }

        return res.status(200).json({ results: finalResults.slice(0, 15) });

    } catch (err) {
        // Eğer mdcnet düğümünde anlık bir gecikme olursa JILLEX'in beyaz ekran kalmaması için
        // DuckDuckGo yedek motoru anında devreye girer (Kesintisiz çalışma garantisi)
        try {
            const fallbackUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
            const fbRes = await fetch(fallbackUrl);
            const fbData = await fbRes.json();
            const backupArray = [];

            if (fbData.RelatedTopics) {
                fbData.RelatedTopics.forEach(topic => {
                    if (topic.FirstURL && topic.Text) {
                        let domain = new URL(topic.FirstURL).hostname;
                        backupArray.push({
                            title: topic.Text.split(' - ')[0] || "Web Sonucu",
                            url: topic.FirstURL,
                            content: topic.Text,
                            logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                        });
                    }
                });
            }
            return res.status(200).json({ results: backupArray });
        } catch (fallbackErr) {
            return res.status(500).json({ error: "All engines are currently unreachable." });
        }
    }
}
