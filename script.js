// Google Programmable Search Engine Bilgilerin
const API_KEY = 'AIzaSyDzzLl0Y0qoo9LD_gndsaAZbQWc4mrqnMI';
const CX_ID = '5737e65ea478a419a';

document.getElementById('search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const query = document.getElementById('search-input').value.trim();
    if (!query) return;

    searchJillex(query);
});

async function searchJillex(query) {
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '<div class="loading">Jillex arıyor...</div>';

    const url = `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX_ID}&q=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        resultsContainer.innerHTML = ''; // Yükleniyor yazısını temizle

        if (data.items && data.items.length > 0) {
            data.items.forEach(item => {
                const resultItem = document.createElement('div');
                resultItem.className = 'result-item';

                resultItem.innerHTML = `
                    <a href="${item.link}" target="_blank">${item.title}</a>
                    <div class="display-link">${item.link}</div>
                    <p>${item.snippet}</p>
                `;
                resultsContainer.appendChild(resultItem);
            });
        } else {
            resultsContainer.innerHTML = '<div class="no-results">Sonuç bulunamadı.</div>';
        }
    } catch (error) {
        console.error('Arama hatası:', error);
        resultsContainer.innerHTML = '<div class="no-results">Arama sırasında bir hata oluştu.</div>';
    }
}
