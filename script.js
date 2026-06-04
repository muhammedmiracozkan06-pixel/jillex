document.addEventListener('DOMContentLoaded', () => {
    const searchForm = document.getElementById('search-form');
    const searchInput = document.getElementById('search-input');
    const resultsContainer = document.getElementById('results-container');

    searchForm.addEventListener('submit', async function(e) {
        // Sayfanın yenilenmesini ve URL'in /? olmasını kesin olarak engeller
        e.preventDefault(); 
        
        const query = searchInput.value.trim();
        if (!query) return;

        resultsContainer.innerHTML = '<div class="loading">Jillex arıyor...</div>';

        // DuckDuckGo Ücretsiz ve Key-siz JSON API'si
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            resultsContainer.innerHTML = ''; // Yükleniyor yazısını sil

            let hasResults = false;

            // 1. Durum: Doğrudan soyut/özet bilgi varsa (Instant Answer)
            if (data.AbstractText) {
                hasResults = true;
                createResultCard(data.Heading, data.AbstractURL, data.AbstractText);
            }

            // 2. Durum: İlgili diğer sonuçlar/linkler varsa
            if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                data.RelatedTopics.forEach(item => {
                    // DuckDuckGo bazen alt başlık grupları döndürür, onları eliyoruz
                    if (item.FirstURL && item.Text) {
                        hasResults = true;
                        // Başlık ve açıklama ayıklama
                        const title = item.Text.split(' - ')[0] || 'Sonuç';
                        createResultCard(title, item.FirstURL, item.Text);
                    }
                });
            }

            if (!hasResults) {
                resultsContainer.innerHTML = '<div class="no-results">Aradığınız kritere uygun sonuç bulunamadı.</div>';
            }

        } catch (error) {
            console.error('Arama motoru hatası:', error);
            resultsContainer.innerHTML = '<div class="no-results">Arama servisine bağlanılamadı. Lütfen tekrar deneyin.</div>';
        }
    });

    // Kart oluşturma fonksiyonu
    function createResultCard(title, url, snippet) {
        const resultItem = document.createElement('div');
        resultItem.className = 'result-item';
        resultItem.innerHTML = `
            <a href="${url}" target="_blank">${title}</a>
            <div class="display-link">${url}</div>
            <p>${snippet}</p>
        `;
        resultsContainer.appendChild(resultItem);
    }
});
