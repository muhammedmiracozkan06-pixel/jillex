import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Supabase Bağlantısı
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
    const { q } = req.query;
    if (!q) return res.status(400).json({ results: [] });
    
    const searchKeyword = q.toLowerCase().trim();
    let finalResults = [];

    try {
        // ADIM 1: Önce c-xellas botlarının kendi Supabase hafızasına bak
        const { data: localMemory } = await supabase
            .from('jillex_index')
            .select('url, title, snippet')
            .ilike('search_vector', `%${searchKeyword}%`)
            .limit(5);

        if (localMemory && localMemory.length > 0) {
            localMemory.forEach(item => {
                finalResults.push({
                    url: item.url,
                    title: item.title,
                    snippet: item.snippet,
                    isBotMemory: true // Arayüzde "c-xellas hafızası" amblemi için
                });
            });
        }

        // ADIM 2: Kalan sonuçları DuckDuckGo HTML sürümünden BEDAVA ve SINIRSIZ çek
        try {
            const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchKeyword)}`;
            const response = await axios.get(ddgUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                timeout: 5000
            });

            // Gelen HTML sayfasını c-xellas botları ile parçalıyoruz
            const $ = cheerio.load(response.data);
            
            $('.links_main').each((index, element) => {
                if (finalResults.length >= 15) return false; // Maksimum 15 sonuç göster

                const titleEl = $(element).find('.result__a');
                const title = titleEl.text().trim();
                let rawUrl = titleEl.attr('href');
                const snippet = $(element).next('.result__snippet').text().trim();

                if (title && rawUrl && snippet) {
                    // DuckDuckGo bazen kendi yönlendirme linkini verir, onu temizliyoruz
                    if (rawUrl.includes('uddg=')) {
                        rawUrl = decodeURIComponent(rawUrl.split('uddg=')[1].split('&')[0]);
                    }

                    // Eğer bu site zaten bizim hafızamızdan gelmediyse listeye ekle (Mükerrer önleme)
                    if (!finalResults.some(r => r.url === rawUrl)) {
                        finalResults.push({
                            url: rawUrl,
                            title: title,
                            snippet: snippet,
                            isBotMemory: false
                        });
                    }
                }
            });

        } catch (botErr) {
            console.log("c-xellas dış havuzdan veri çekerken zorlandı, sadece yerel hafıza veriliyor.");
        }

        // Sonuçları ön yüze fırlat
        return res.status(200).json({
            source: "Jıllex Hibrit Havuz (Ücretsiz Mod)",
            total_results: finalResults.length,
            results: finalResults
        });

    } catch (globalErr) {
        return res.status(500).json({ error: globalErr.message });
    }
}
