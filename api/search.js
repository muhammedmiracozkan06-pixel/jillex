// Vercel Serverless Sunucu Dosyası
export default async function handler(req, res) {
    // CORS Engellerini Sunucu Seviyesinde Kaldırıyoruz
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Sorgu boş olamaz." });

    try {
        // İsteği kullanıcının bilgisayarı değil, Amerika'daki Vercel sunucusu atıyor (DNS engeli imkansız)
        const targetUrl = `https://algolia.com{encodeURIComponent(q)}&tags=story`;
        const response = await fetch(targetUrl);
        
        if (!response.ok) throw new Error("Ana sunucu yanıt vermedi.");
        const data = await response.json();

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
