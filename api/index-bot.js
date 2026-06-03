import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Yalnızca POST' });
    const { url } = req.body;

    try {
        // c-xellas botu site kodlarını indiriyor
        const response = await axios.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0 JillexFindBot/1.0 (c-xellas crawler)' },
            timeout: 5000
        });

        const $ = cheerio.load(response.data);
        const title = $('title').text().trim() || 'Başlıksız';
        const description = $('meta[name="description"]').attr('content') || 'Açıklama yok.';
        const search_vector = (title + " " + description).toLowerCase();

        // Hafızaya (Supabase SQL) kaydet veya eskiyse güncelle (upsert)
        const { data, error } = await supabase
            .from('jillex_index')
            .upsert([{ url, title, snippet: description, search_vector }], { onConflict: 'url' });

        if (error) throw error;
        return res.status(200).json({ success: true, indexed: { url, title } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}
