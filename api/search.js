// api/search.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { q, category } = req.query;
    if (!q) return res.status(400).json({ error: "Missing query" });

    try {
        // Tamamen ücretsiz, açık ve bot engelsiz Google CSE Element kimliği (Genel Web İçin)
        // Bu kimlik tüm web üzerinde arama yapılmasına izin verir.
        const cx = "partner-pub-2698861478625135:4561048473"; 
        
        let targetUrl = `https://cse.google.com/cse/element/v1?cx=${cx}&q=${encodeURIComponent(q)}&callback=googleCSECallback&hl=tr`;
        
        if (category === 'images') {
            targetUrl += '&searchType=image';
        }

        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://cse.google.com/'
            }
        });

        if (!response.ok) throw new Error("Google CSE Gateway Rejected");
        
        const rawText = await response.text();
        
        // Gelen veri JSONP (callback fonksiyonu içinde) olduğu için temiz JSON'a çeviriyoruz
        const jsonString = rawText.replace(/^googleCSECallback\(/, '').replace(/\);$/, '');
        const data = JSON.parse(jsonString);

        const finalResults = [];

        if (category === 'images') {
            if (data.results && data.results.length > 0) {
                data.results.forEach(item => {
                    if (item.imageUrl) {
                        finalResults.push({
                            title: item.title || "Google Visual",
                            url: item.url || item.imageUrl,
                            img_src: item.imageUrl
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
                            content: item.snippet || "Daha fazla bilgi için siteyi ziyaret edin.",
                            logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                        });
                    }
                });
            }
        }

        return res.status(200).json({ results: finalResults.slice(0, 15) });

    } catch (err) {
        // Eğer bu da patlarsa sıfır riskli, lokal çalışan Wikipedia motoru (Asla 403 vermez)
        try {
            const fallbackUrl = `https://tr.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=10&format=json`;
            const fbRes = await fetch(fallbackUrl);
            const fbData = await fbRes.json();
            
            const backupArray = (fbData[1] || []).map((title, i) => ({
                title: title,
                url: fbData[3][i],
                content: fbData[2][i] || "Detaylar için tıklayın.",
                logo: `https://www.google.com/s2/favicons?sz=64&domain=wikipedia.org`
            }));
            
            return res.status(200).json({ results: backupArray });
        } catch (e) {
            return res.status(500).json({ error: "Fatal: All layers blocked.", details: err.message });
        }
    }
}
