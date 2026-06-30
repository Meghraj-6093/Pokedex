/**
 * Pokédex X Pro - FAANG Level Logic
 * Handles API interactions, Cache, Favorites, Share, POTD, and Fuzzy Search
 */

// --- Configuration ---
const API_URL = "https://pokeapi.co/api/v2/pokemon";
const LIMIT = 1000;

// --- State Variables ---
let currentPokemonAudio = null;
let allPokemonNames = [];
let pokemonCache = new Map();
let currentPokemonData = null;
let favorites = JSON.parse(localStorage.getItem('pokedex_favorites') || '[]');

// --- DOM References ---
const searchInput = document.getElementById('searchInput');
const suggestionsBox = document.getElementById('suggestionsBox');
const card = document.getElementById('pokemonCard');
const loader = document.getElementById('loader');
const errorContainer = document.getElementById('errorContainer');
const errorMsg = document.getElementById('errorMsg');
const errorSuggestions = document.getElementById('errorSuggestions');
const themeBtn = document.getElementById('theme-btn');
const favoritesSection = document.getElementById('favoritesSection');
const favoritesGrid = document.getElementById('favoritesGrid');
const potdBanner = document.getElementById('potdBanner');
const potdName = document.getElementById('potdName');
const potdBtn = document.getElementById('potdBtn');
const favCardBtn = document.getElementById('favCardBtn');

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
    await fetchAllNames();
    renderFavorites();
    setupPOTD();
    
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker registered successfully:', reg.scope))
                .catch(err => console.log('Service Worker registration failed:', err));
        });
    }
    
    // Fetch a random Pokemon (1-898) or the POTD to show a live state immediately
    const randomId = Math.floor(Math.random() * 898) + 1;
    fetchPokemon(randomId);
});

// --- Theme Management ---
function toggleTheme() {
    const body = document.body;
    const isDark = body.classList.contains('dark-mode');
    
    if (isDark) {
        body.classList.remove('dark-mode');
        body.classList.add('light-mode');
        themeBtn.innerHTML = '<i class="fa-solid fa-moon"></i>';
    } else {
        body.classList.remove('light-mode');
        body.classList.add('dark-mode');
        themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
    }
}
window.toggleTheme = toggleTheme;

// --- Data Fetching: Names List (Optimized) ---
async function fetchAllNames() {
    try {
        const res = await fetch(`${API_URL}?limit=${LIMIT}`);
        const data = await res.json();
        allPokemonNames = data.results.map(p => p.name);
    } catch (e) {
        console.error("Failed to load names database", e);
    }
}

// --- Fuzzy Search Scoring Algorithms ---
function fuzzyMatchScore(str, pattern) {
    str = str.toLowerCase();
    pattern = pattern.toLowerCase();

    if (str === pattern) return 1.0;
    if (str.startsWith(pattern)) return 0.8 + (pattern.length / str.length) * 0.2;
    if (str.includes(pattern)) return 0.5 + (pattern.length / str.length) * 0.3;

    // Subsequence check
    let matchCount = 0;
    let patternIdx = 0;
    for (let i = 0; i < str.length && patternIdx < pattern.length; i++) {
        if (str[i] === pattern[patternIdx]) {
            matchCount++;
            patternIdx++;
        }
    }
    if (patternIdx === pattern.length) {
        return 0.4 + (pattern.length / str.length) * 0.2;
    }

    // Levenshtein distance threshold for misspelling
    const distance = editDistance(str, pattern);
    const maxLen = Math.max(str.length, pattern.length);
    const similarity = (maxLen - distance) / maxLen;
    return similarity > 0.55 ? similarity * 0.45 : 0;
}

function editDistance(s1, s2) {
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1[i - 1] !== s2[j - 1]) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) {
            costs[s2.length] = lastValue;
        }
    }
    return costs[s2.length];
}

// --- Search Interaction with Fuzzy Suggestions ---
searchInput.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase().trim();
    suggestionsBox.innerHTML = '';
    suggestionsBox.classList.remove('active');

    if (!val) return;

    // Filter and score candidates
    const scored = allPokemonNames
        .map(name => ({ name, score: fuzzyMatchScore(name, val) }))
        .filter(item => item.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    
    if (scored.length > 0) {
        suggestionsBox.classList.add('active');
        scored.forEach(item => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `<strong>${item.name}</strong> <span style="font-size:0.8em; opacity: 0.6;">Match</span>`;
            
            div.onclick = () => {
                searchInput.value = item.name;
                suggestionsBox.classList.remove('active');
                fetchPokemon(item.name);
            };
            suggestionsBox.appendChild(div);
        });
    }
});

// UX Hooks for Search
document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
        suggestionsBox.classList.remove('active');
    }
});

searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        suggestionsBox.classList.remove('active');
        fetchPokemon(searchInput.value.toLowerCase().trim());
    }
});

// --- Main Data Fetching Logic (with Cache & Error Recovery) ---
async function fetchPokemon(query) {
    if (!query) return;

    // 1. Reset UI State
    card.classList.remove('visible');
    loader.style.display = 'flex';
    errorContainer.style.display = 'none';

    // 2. Performance Cache hit check
    const cacheKey = query.toString().toLowerCase().trim();
    if (pokemonCache.has(cacheKey)) {
        const cachedData = pokemonCache.get(cacheKey);
        updateUI(cachedData);
        return;
    }

    // Check online status first
    if (!navigator.onLine) {
        showError("Network connection offline.", "Please verify your local network status or Wi-Fi connection and try again.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/${query}`);
        if (!res.ok) {
            throw new Error(`Pokemon "${query}" could not be located.`);
        }
        const data = await res.json();
        
        // Save to cache
        pokemonCache.set(data.name.toLowerCase(), data);
        pokemonCache.set(data.id.toString(), data);
        
        updateUI(data);
    } catch (err) {
        // Find typo corrections for user-friendly suggestions
        const candidates = allPokemonNames
            .map(name => ({ name, score: fuzzyMatchScore(name, query.toString()) }))
            .filter(item => item.score > 0.25)
            .sort((a, b) => b.score - a.score)
            .slice(0, 4);

        let subMsg = "Verify spelling, or browse suggested Pokémon below:";
        if (candidates.length === 0) {
            subMsg = "Check spelling or search for popular ones like Charizard, Mewtwo, or Pikachu.";
        }

        showError(`Oops! Pokémon "${query}" was not found.`, subMsg, candidates);
    }
}
window.fetchPokemon = fetchPokemon;

function showError(primary, secondary, suggestions = []) {
    loader.style.display = 'none';
    errorMsg.innerHTML = `<strong><i class="fa-solid fa-triangle-exclamation"></i> ${primary}</strong><br>${secondary}`;
    
    errorSuggestions.innerHTML = '';
    if (suggestions && suggestions.length > 0) {
        const title = document.createElement('div');
        title.className = 'suggestion-title';
        title.textContent = "Did you mean:";
        errorSuggestions.appendChild(title);

        const linksWrap = document.createElement('div');
        linksWrap.className = 'suggestion-links';
        suggestions.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'error-suggest-link';
            btn.textContent = item.name;
            btn.onclick = () => fetchPokemon(item.name);
            linksWrap.appendChild(btn);
        });
        errorSuggestions.appendChild(linksWrap);
        errorSuggestions.style.display = 'flex';
    } else {
        errorSuggestions.style.display = 'none';
    }

    errorContainer.style.display = 'flex';
}

// --- UI Rendering Logic ---
function updateUI(data) {
    currentPokemonData = data;

    // A. Text Info
    document.getElementById('pokeName').textContent = data.name;
    document.getElementById('pokeId').textContent = `#${data.id.toString().padStart(3, '0')}`;
    
    // B. Performance: Lazy/Fade-in Image Loading
    const img = document.getElementById('pokeImg');
    img.classList.remove('loaded');
    
    const imgSrc = data.sprites.other.dream_world.front_default || 
                   data.sprites.other['official-artwork'].front_default ||
                   data.sprites.front_default;
                   
    img.onload = () => {
        img.classList.add('loaded');
    };
    img.src = imgSrc;

    // C. Types & Dynamic Styling
    const typesDiv = document.getElementById('typesContainer');
    typesDiv.innerHTML = '';
    const mainType = data.types[0].type.name;
    
    // Set type CSS variable & clean previous type-specific classes
    const typeVar = `var(--t-${mainType})`;
    card.style.setProperty('--type-color', typeVar);
    
    // Remove old type classes
    card.className = 'card';
    card.classList.add(`type-${mainType}`);

    data.types.forEach(t => {
        const badge = document.createElement('span');
        badge.className = 'type-badge';
        badge.style.background = `var(--t-${t.type.name})`;
        badge.textContent = t.type.name;
        typesDiv.appendChild(badge);
    });

    // D. Stats Visualization
    const statsDiv = document.getElementById('statsContainer');
    statsDiv.innerHTML = '';
    let hp = 0;

    data.stats.forEach(s => {
        if(s.stat.name === 'hp') hp = s.base_stat;

        const row = document.createElement('div');
        row.className = 'stat-row';
        
        let label = s.stat.name.replace('special-attack', 'Sp. Atk')
                               .replace('special-defense', 'Sp. Def');
        
        row.innerHTML = `
            <div class="stat-label">${label}</div>
            <div class="stat-val">${s.base_stat}</div>
            <div class="stat-bar-bg">
                <div class="stat-bar-fill" style="width: 0%"></div>
            </div>
        `;
        statsDiv.appendChild(row);

        setTimeout(() => {
            row.querySelector('.stat-bar-fill').style.width = `${Math.min(s.base_stat, 160) / 1.6}%`;
        }, 100);
    });

    document.getElementById('hpVal').textContent = hp;

    // E. Update Favorite Heart state
    updateFavoriteButtonState();

    // F. Audio Cry
    const latestCry = data.cries?.latest || data.cries?.legacy;
    currentPokemonAudio = latestCry ? new Audio(latestCry) : null;
    if(currentPokemonAudio) {
        currentPokemonAudio.volume = 0.25;
        currentPokemonAudio.play().catch(e => { /* Browser autoplay safety block */ });
    }

    // G. Show Card
    loader.style.display = 'none';
    setTimeout(() => {
        card.classList.add('visible');
    }, 50);
}

// --- Audio Trigger & Bump Animation ---
function playCry() {
    if (currentPokemonAudio) {
        currentPokemonAudio.currentTime = 0;
        currentPokemonAudio.play().catch(e => console.log("Audio requires manual interaction first"));
        
        const img = document.getElementById('pokeImg');
        if(img) {
            img.style.transform = "scale(1.18) rotate(3deg)";
            setTimeout(() => img.style.transform = "scale(1) rotate(0deg)", 200);
        }
    } else {
        console.warn("No cry audio is available for this Pokémon.");
    }
}
window.playCry = playCry;

// --- Favorites System Logic ---
function toggleFavoritesSection() {
    favoritesSection.classList.toggle('active');
    renderFavorites();
}
window.toggleFavoritesSection = toggleFavoritesSection;

function toggleFavoriteCurrent() {
    if (!currentPokemonData) return;
    
    const id = currentPokemonData.id;
    const index = favorites.findIndex(p => p.id === id);
    
    if (index === -1) {
        // Add to favorites
        const miniSprite = currentPokemonData.sprites.front_default || currentPokemonData.sprites.other['official-artwork'].front_default;
        favorites.push({
            id: currentPokemonData.id,
            name: currentPokemonData.name,
            sprite: miniSprite,
            type: currentPokemonData.types[0].type.name
        });
    } else {
        // Remove from favorites
        favorites.splice(index, 1);
    }
    
    localStorage.setItem('pokedex_favorites', JSON.stringify(favorites));
    updateFavoriteButtonState();
    renderFavorites();
}
window.toggleFavoriteCurrent = toggleFavoriteCurrent;

function updateFavoriteButtonState() {
    if (!currentPokemonData) return;
    const isFav = favorites.some(p => p.id === currentPokemonData.id);
    if (isFav) {
        favCardBtn.classList.add('active');
        favCardBtn.innerHTML = '<i class="fa-solid fa-heart"></i>';
    } else {
        favCardBtn.classList.remove('active');
        favCardBtn.innerHTML = '<i class="fa-regular fa-heart"></i>';
    }
}

function removeFavoriteById(id) {
    favorites = favorites.filter(p => p.id !== id);
    localStorage.setItem('pokedex_favorites', JSON.stringify(favorites));
    updateFavoriteButtonState();
    renderFavorites();
}
window.removeFavoriteById = removeFavoriteById;

function clearAllFavorites() {
    if (confirm("Are you sure you want to clear all favorite Pokémon?")) {
        favorites = [];
        localStorage.setItem('pokedex_favorites', JSON.stringify(favorites));
        updateFavoriteButtonState();
        renderFavorites();
    }
}
window.clearAllFavorites = clearAllFavorites;

function renderFavorites() {
    favoritesGrid.innerHTML = '';
    if (favorites.length === 0) {
        favoritesGrid.innerHTML = '<p class="no-favorites-msg">No favorites added yet. Click the heart icon on a Pokémon card!</p>';
        return;
    }
    
    favorites.forEach(p => {
        const item = document.createElement('div');
        item.className = 'favorite-mini-card';
        item.style.borderLeft = `4px solid var(--t-${p.type})`;
        
        item.innerHTML = `
            <button class="remove-fav-mini-btn" onclick="event.stopPropagation(); removeFavoriteById(${p.id})">&times;</button>
            <img class="favorite-mini-img" src="${p.sprite}" alt="${p.name}">
            <span class="favorite-mini-name">${p.name}</span>
        `;
        item.onclick = () => {
            fetchPokemon(p.id);
        };
        favoritesGrid.appendChild(item);
    });
}

// --- Pokémon of the Day (POTD) Engine ---
function setupPOTD() {
    // Generate seeded random index based on Date
    const today = new Date();
    const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    
    // Quick seeded pseudo-random
    let seed = dateSeed;
    function random() {
        let x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }
    
    // Pick id from 1 to 898
    const potdId = Math.floor(random() * 898) + 1;
    
    fetch(`${API_URL}/${potdId}`)
        .then(res => res.json())
        .then(data => {
            potdName.textContent = data.name;
            potdBtn.onclick = () => {
                fetchPokemon(data.id);
            };
        })
        .catch(err => {
            console.error("POTD fetch failed", err);
            potdBanner.style.display = 'none';
        });
}

// --- Social Share Integration ---
function shareCurrentPokemon() {
    if (!currentPokemonData) return;
    
    const name = currentPokemonData.name.toUpperCase();
    const id = currentPokemonData.id;
    const hp = currentPokemonData.stats.find(s => s.stat.name === 'hp')?.base_stat || 0;
    const types = currentPokemonData.types.map(t => t.type.name).join('/');
    
    const shareText = `Check out ${name} (#${id.toString().padStart(3, '0')}) on Pokédex X Pro! HP: ${hp} | Types: ${types}.`;
    const shareUrl = window.location.href;

    if (navigator.share) {
        navigator.share({
            title: `Pokédex X Pro | ${name}`,
            text: shareText,
            url: shareUrl,
        }).catch(err => console.log("Share failed or cancelled", err));
    } else {
        // Fallback: Copy to Clipboard & Show prompt options
        navigator.clipboard.writeText(`${shareText} ${shareUrl}`).then(() => {
            alert(`Copied stats to Clipboard!\n\n"${shareText}"\n\nYou can now paste and share with friends.`);
        }).catch(err => {
            console.error("Copy failed", err);
        });
    }
}
window.shareCurrentPokemon = shareCurrentPokemon;