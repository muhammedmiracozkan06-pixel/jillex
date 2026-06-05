const https = require('https');

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    const { q } = req.query;
    if (!q) {
        return res.status(400).json({ error: true, message: "Arama sorgusu boş olamaz." });
    }

    const API_KEY = "AIzaSyDzzLl0Y0qoo9LD_gndsaAZbQWc4mrqnMI";
    const CX_ID = "5737e6ea478a419a";
    
    // URL dizilimi kesin olarak düzeltildi (Soru işareti ve parametre geçişleri ayrıldı)
    const googleUrl = `https://googleapis.com{API_KEY}&cx=${CX_ID}&q=${encodeURIComponent(q)}`;

    https.get(googleUrl, (googleRes) => {
        let rawData = '';

        googleRes.on('data', (chunk) => { rawData += chunk; });

        googleRes.on('end', () => {
            try {
                const data = JSON.parse(rawData);
                
                if (data.error) {
                    return res.status(200).json({ 
                        error: true, 
                        message: data.error.message,
                        reason: data.error.status || "Google_API_Kısıtlaması"
                    });
                }
                
                return res.status(200).json(data);
            } catch (e) {
                return res.status(200).json({ error: true, message: "Veri çözümleme hatası: " + e.message });
            }
        });

    }).on('error', (err) => {
        return res.status(200).json({ error: true, message: "Güvenli tünel oluşturulamadı: " + err.message });
    });
}
