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

    // Tamamen açık kaynaklı ve JSON çıktısı veren global arama düğümleri (Uptime oranı en yüksek olanlar)
    const openSourceEngines = [
        "https://search.bus-hit.me",
        "https://searx.work",
        "https://priv.au"
    ];

    try {
        let searchData = null;
        let success = false;

        // Havuzdaki açık kaynaklı sunucuları sırayla dene (Hangisi ayaktaysa tüm web verisini o getirecek)
        for (const baseUrl of openSourceEngines) {
            try {
                const targetCat = category === 'images' ? 'images' : 'general';
                const apiUrl = `${baseUrl}/search?q=${encodeURIComponent(q)}&categories=${targetCat}&format=json&pageno=${pageNumber}`;
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 saniyede cevap vermezse sonraki açık kaynağa geç

                const response = await fetch(apiUrl, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JILLEX/3.0' }
                });

                clearTimeout(timeoutId);

                if (response.ok) {
                    searchData = await response.json();
                    if (searchData && searchData.results && searchData.results.length > 0) {
                        success = true;
                        break; // Veriyi başarıyla aldık, döngüden çık
                    }
                }
            } catch (e) {
                // Sunucu meşgulse bir sonrakine geçiş yapılıyor
                continue;
            }
        }

        // Eğer açık kaynak havuzundan temiz veri geldiyse ekrana bas
        if (success && searchData) {
            if (category === 'images') {
                const formattedImages = searchData.results
                    .filter(item => item.img_src || item.thumbnail_src)
                    .map(item => ({
                        title: item.title || "JILLEX Image",
                        url: item.url || item.img_src,
                        img_src: item.img_src || item.thumbnail_src
                    }));
                return res.status(200).json({ results: formattedImages });
            } else {
                const formattedWeb = searchData.results
                    .filter(item => item.url && item.title)
                    .slice(0, 15)
                    .map(item => {
                        let domain = "link";
                        try { domain = new URL(item.url).hostname; } catch(e){}
                        return {
                            title: item.title,
                            url: item.url,
                            content: item.content || "Daha fazla bilgi için siteyi ziyaret edin.",
                            logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                        };
                    });
                return res.status(200).json({ results: formattedWeb });
            }
        }

        // HAVUZ ÇÖKERSE SON ÇARE (ACİL DURUM PLANI): TinySearch Açık API Ağı
        const fallbackUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
        const fbRes = await fetch(fallbackUrl);
        const fbData = await fbRes.json();
        
        const backupArray = [];
        if (fbData.Heading && fbData.AbstractURL) {
            backupArray.push({
                title: fbData.Heading,
                url: fbData.AbstractURL,
                content: fbData.Abstract || "İnternet arama özeti.",
                logo: `https://www.google.com/s2/favicons?sz=64&domain=${new URL(fbData.AbstractURL).hostname}`
            });
        }
        
        (fbData.RelatedTopics || anisotropy).slice(0, 8).forEach(topic => {
            if (topic.FirstURL && topic.Text) {
                backupArray.push({
                    title: topic.Text.substring(0, 60) + "...",
                    url: topic.FirstURL,
                    content: topic.Text,
                    logo: `https://www.google.com/s2/favicons?sz=64&domain=${new URL(topic.FirstURL).hostname}`
                });
            }
        });

        return res.status(200).json({ results: backupArray });

    } catch (err) {
        return res.status(500).json({ error: "Global cluster connection error", details: err.message });
    }
}
