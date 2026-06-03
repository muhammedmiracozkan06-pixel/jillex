import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
    const { q } = req.query;
    if (!q) return res.status(400).json({ results: [] });
    const searchKeyword = q.toLowerCase().trim();
    let finalResults = [];

    try {
        // ADIM 1: c-xellas özel hafızasından sorgula
        const { data: localMemory } = await supabase
            .from('jillex_index')
            .select('url, title, snippet')
            .ilike('search_vector', `%${searchKeyword}%`)
            .limit(5);

        if (localMemory) {
            localMemory.forEach(item => {
                finalResults.push({ url: item.url, title: item.title, snippet: item.snippet, isBotMemory: true });
            });
        }

        // ADIM 2: Global genel havuzdan (Brave API) sonuçları tamamla
        try {
            const braveRes = await axios.get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchKeyword)}`, {
                headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY }
            });
            if (braveRes.data?.web?.results) {
                braveRes.data.web.results.slice(0, 10).forEach(item => {
                    if (!finalResults.some(r => r.url === item.url)) {
                        finalResults.push({ url: item.url, title: item.title, snippet: item.description, isBotMemory: false });
                    }
                });
            }
        } catch (e) { console.log("Brave API limiti dolmuş veya anahtar girilmemiş."); }

        return res.status(200).json({ total_results: finalResults.length, results: finalResults });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
