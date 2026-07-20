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
        // Sınırsız ve bot korumalarını otomatik aşan açık kaynaklı global web dizini proxy'si
        const proxyUrl = `https://api.mojeek.com/search?q=${encodeURIComponent(q)}&fmt=json`;
        
        const response = await fetch(proxyUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JILLEX-Engine/4.0 (Wind Developers)'
            }
        });

        if (!response.ok) throw new Error("Central proxy down");
        const data = await response.json();
        const finalResults = [];

        if (category === 'images') {
            // Görsel modunda açık kaynaklı Wikimedia Commons veri tabanını sıfır limitle kazıyoruz
            const wikiImgUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json&origin=*`;
            const imgRes = await fetch(wikiImgUrl);
            const imgData = await imgRes.json();
            
            if (imgData.query && imgData.query.pages) {
                Object.values(imgData.query.pages).forEach(p => {
                    if (p.imageinfo && p.imageinfo[0]) {
                        finalResults.push({
                            title: p.title.replace('File:', '') || "JILLEX Visual",
                            url: p.imageinfo[0].descriptionurl,
                            img_src: p.imageinfo[0].url
                        });
                    }
                });
            }
        } else {
            // Web Sonuçlarını İşleme (Mojeek Küresel İndeksi)
            if (data.results && data.results.length > 0) {
                data.results.forEach(item => {
                    let domain = "link";
                    try { domain = new URL(item.url).hostname; } catch(e){}

                    finalResults.push({
                        title: item.title || "Untitled Document",
                        url: item.url,
                        content: item.desc || "Daha fazla bilgi için kaynağı ziyaret edin.",
                        logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                    });
                });
            }
        }

        // Eğer ana motor o an boş dönerse yedek sınırsız açık kaynak havuzu (DuckDuckGo Lite API) anında besler
        if (finalResults.length === 0) {
            const fallbackUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
            const fbRes = await fetch(fallbackUrl);
            const fbData = await fbRes.json();

            if (fbData.Heading && fbData.AbstractURL) {
                finalResults.push({
                    title: fbData.Heading,
                    url: fbData.AbstractURL,
                    content: fbData.Abstract,
                    logo: `https://www.google.com/s2/favicons?sz=64&domain=${new URL(fbData.AbstractURL).hostname}`
                });
            }

            if (fbData.RelatedTopics) {
                fbData.RelatedTopics.forEach(topic => {
                    if (topic.FirstURL && topic.Text) {
                        let domain = new URL(topic.FirstURL).hostname;
                        finalResults.push({
                            title: topic.Text.split(' - ')[0] || "Web Sonucu",
                            url: topic.FirstURL,
                            content: topic.Text,
                            logo: `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
                        });
                    }
                });
            }
        }

        return res.status(200).json({ results: finalResults.slice(0, 15) });

    } catch (err) {
        return res.status(500).json({ error: "JILLEX Core Infrastructure Error", details: err.message });
    }
}
