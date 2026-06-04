const API_KEY = "AIzaSyDzzLl0Y0qoo9LD_gndsaAZbQWc4mrqnMI";
const CX = "5737e65ea478a419a";

const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const resultsDiv = document.getElementById("results");

searchBtn.addEventListener("click", search);
searchInput.addEventListener("keydown", e => {
    if(e.key === "Enter"){
        search();
    }
});

async function search() {

    const query = searchInput.value.trim();

    if(!query) return;

    resultsDiv.innerHTML = "<p>Aranıyor...</p>";

    try{

        const response = await fetch(
            `https://www.googleapis.com/customsearch/v1?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}`
        );

        const data = await response.json();

        resultsDiv.innerHTML = "";

        if(!data.items){
            resultsDiv.innerHTML = "<p>Sonuç bulunamadı.</p>";
            return;
        }

        data.items.forEach(item => {

            const div = document.createElement("div");
            div.className = "result";

            div.innerHTML = `
                <a href="${item.link}" target="_blank">
                    ${item.title}
                </a>
                <p>${item.snippet}</p>
            `;

            resultsDiv.appendChild(div);
        });

    } catch(err){

        console.error(err);

        resultsDiv.innerHTML =
            "<p>Arama sırasında hata oluştu.</p>";
    }
}
