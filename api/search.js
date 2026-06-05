export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: "Arama sorgusu boş olamaz." });
    }

    const API_KEY = "AIzaSyDzzLl0Y0qoo9LD_gndsaAZbQWc4mrqnMI";
    const CX_ID = "5737e6ea478a419a";
    
    const googleUrl = `https://googleapis.com{API_KEY}&cx=${CX_ID}&q=${encodeURIComponent(q)}`;

    try {
        const response = await fetch(googleUrl);
        const data = await response.json();
        
        // 🎯 EĞER GOOGLE HATA DÖNDÜRDÜYSE, 500 VERME, HATAYI KULLANICIYA GÖSTER!
        if (data.error) {
            return res.status(200).json({ 
                error: true, 
                message: data.error.message,
                reason: data.error.status || "Bilinmiyor"
            });
        }
        
        return res.status(200).json(data);
    } catch (error) {
        // Sunucu tamamen kilitlenirse bile arayüze bilgi gönder
        return res.status(200).json({ error: true, message: "Vercel Sunucu Hatası: " + error.message });
    }
}
