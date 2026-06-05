export default async function handler(req, res) {
    // Güvenlik ve CORS başlıklarını tanımlıyoruz
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: "Arama sorgusu boş olamaz." });
    }

    // Sizin sağladığınız resmi Google Cloud anahtarları
    const API_KEY = "AIzaSyDzzLl0Y0qoo9LD_gndsaAZbQWc4mrqnMI";
    const CX_ID = "5737e6ea478a419a";
    
    const googleUrl = `https://googleapis.com{API_KEY}&cx=${CX_ID}&q=${encodeURIComponent(q)}`;

    try {
        const response = await fetch(googleUrl);
        const data = await response.json();
        
        // Google'dan gelen ham veriyi doğrudan kullanıcıya güvenli kanal olarak iletiyoruz
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: "Sunucu bağlantı hatası: " + error.message });
    }
}
