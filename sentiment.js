let rawData = [];
let lgaMap = {}; 
let map;
let geojsonLayer;
let selectedLga = null; 

let charts = {
    violence: null,
    tension: null,
    safety: null,
    mood: null,
    rankingSafety: null,
    rankingHotspots: null
};

const VALID_LGAS = new Set([
    "agege", "ajeromiifelodun", "alimosho", "amuwoodofin", "apapa",
    "badagry", "epe", "etiosa", "ibejulekki", "ifakoijaiye", "ifakoijaye", 
    "ikeja", "ikorodu", "kosofe", "lagosisland", "lagosmainland", "mainland",
    "mushin", "ojo", "oshodiisolo", "shomolu", "surulere"
]);

function normalizeLGA(name) {
    if (!name) return "";
    let normalized = name.toLowerCase().replace(/[- \/]/g, "");
    if (normalized === "mainland") return "lagosmainland";
    return normalized;
}

function getSafetyColour(score) {
    if (score >= 75) return '#1a9850'; // Safe
    if (score >= 50) return '#fee08b'; // Moderate
    if (score >= 25) return '#fc8d59'; // Unsafe
    return '#d73027';                  // Very Unsafe
}

function getMapPadding() {
    const rightPanelWidth = window.innerWidth > 1024 ? (window.innerWidth * 0.40) + 40 : 20;
    return {
        paddingTopLeft: [20, 160], 
        paddingBottomRight: [rightPanelWidth, 20]
    };
}

async function loadData() {
    let allData = [];
    let offset = 0;
    const limit = 1000; 
    let keepFetching = true;

    while (keepFetching) {
        const response = await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.TABLE}?select=*&limit=${limit}&offset=${offset}`,
            { headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } }
        );
        
        if (!response.ok) throw new Error(`Database error (Status: ${response.status})`);
        
        const chunk = await response.json();
        allData = allData.concat(chunk);
        
        if (chunk.length < limit) {
            keepFetching = false;
        } else {
            offset += limit;
        }
    }
    
    rawData = allData;
    processData();
    updateUI();
    document.getElementById('last-sync-time').innerText = `Last Sync: ${new Date().toLocaleTimeString()}`;
}

function processData() {
    lgaMap = {};
    
    rawData.forEach(r => {
        const normName = normalizeLGA(r.lga_normalized); 
        if(!normName || !VALID_LGAS.has(normName)) return; 

        if (!lgaMap[normName]) {
            lgaMap[normName] = {
                originalName: r.lga_normalized,
                total: 0,
                sumSafety: 0, sumViol: 0, sumTens: 0, sumCalm: 0,
                safetyCounts: {}, moodCounts: {},
                violCounts: {yes: 0, no: 0}, tensCounts: {yes: 0, no: 0}
            };
        }
        
        const l = lgaMap[normName];
        l.total++;

        // FIX: Wrapped in Number() to prevent string '1' from breaking addition
        l.sumSafety += Number(r.safety_score_num || 0);
        l.sumViol += Number(r.violence_witnessed_binary || 0);
        l.sumTens += Number(r.tensions_noticed_binary || 0);
        l.sumCalm += Number(r.is_calm_binary || 0);

        if(r.safety_feeling) l.safetyCounts[r.safety_feeling] = (l.safetyCounts[r.safety_feeling] || 0) + 1;
        if(r.community_mood) l.moodCounts[r.community_mood] = (l.moodCounts[r.community_mood] || 0) + 1;
        
        // FIX: Strict Number check for binary parsing
        if(Number(r.violence_witnessed_binary) === 1) l.violCounts.yes++; else l.violCounts.no++;
        if(Number(r.tensions_noticed_binary) === 1) l.tensCounts.yes++; else l.tensCounts.no++;
    });

    Object.values(lgaMap).forEach(l => {
        l.avgSafe = l.total > 0 ? (l.sumSafety / l.total) : 0;
        l.pctViol = l.total > 0 ? (l.sumViol / l.total) * 100 : 0;
        l.pctTens = l.total > 0 ? (l.sumTens / l.total) * 100 : 0;
        l.pctCalm = l.total > 0 ? (l.sumCalm / l.total) * 100 : 0;
        l.compIdx = ((l.avgSafe/5)*50) + ((100-l.pctViol)*0.25) + (l.pctCalm*0.25);
    });
}

function aggregateAll() {
    let l = { 
        total: 0, sumSafety: 0, sumViol: 0, sumTens: 0, sumCalm: 0,
        safetyCounts: {}, moodCounts: {}, violCounts: {yes:0, no:0}, tensCounts: {yes:0, no:0}
    };

    Object.values(lgaMap).forEach(m => {
        l.total += m.total;
        l.sumSafety += m.sumSafety; l.sumViol += m.sumViol; 
        l.sumTens += m.sumTens; l.sumCalm += m.sumCalm;
        
        l.violCounts.yes += m.violCounts.yes; l.violCounts.no += m.violCounts.no;
        l.tensCounts.yes += m.tensCounts.yes; l.tensCounts.no += m.tensCounts.no;

        for(let k in m.safetyCounts) l.safetyCounts[k] = (l.safetyCounts[k]||0) + m.safetyCounts[k];
        for(let k in m.moodCounts) l.moodCounts[k] = (l.moodCounts[k]||0) + m.moodCounts[k];
    });

    l.avgSafe = l.total > 0 ? (l.sumSafety / l.total) : 0;
    l.pctViol = l.total > 0 ? (l.sumViol / l.total) * 100 : 0;
    l.pctTens = l.total > 0 ? (l.sumTens / l.total) * 100 : 0;
    l.pctCalm = l.total > 0 ? (l.sumCalm / l.total) * 100 : 0;
    l.compIdx = ((l.avgSafe/5)*50) + ((100-l.pctViol)*0.25) + (l.pctCalm*0.25);

    return l;
}

async function initMap() {
    map = L.map('map', { zoomControl: false }).setView([6.5244, 3.3792], 10);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 20
    }).addTo(map);

    function adjustMapLabels() {
        const currentZoom = map.getZoom();
        const mapContainer = document.getElementById('map');
        if (currentZoom < 10) mapContainer.classList.add('hide-labels');
        else {
            mapContainer.classList.remove('hide-labels');
            let newSize = 0.55 + ((currentZoom - 10) * 0.15);
            if (newSize > 1.1) newSize = 1.1; 
            mapContainer.style.setProperty('--dynamic-label-size', `${newSize}rem`);
        }
    }
    adjustMapLabels(); map.on('zoomend', adjustMapLabels);

    let geoData;
    try {
        const response = await fetch(CONFIG.GEOJSON_URL);
        if (!response.ok) throw new Error(`HTTP error!`);
        const rawGeo = await response.json();
        geoData = { type: "FeatureCollection", features: rawGeo.features.filter(f => f.properties.NAME_1 && f.properties.NAME_1.trim().toLowerCase() === "lagos") };
    } catch (e) {
        document.getElementById('map').innerHTML += `<div style="position:absolute; top:40%; width:100%; text-align:center; color:#ff6b6b; z-index:999; font-family:monospace; background:rgba(0,0,0,0.8); padding:10px;"><b>File Not Found:</b> Ensure ${CONFIG.GEOJSON_URL} is present.</div>`;
        return;
    }

    geojsonLayer = L.geoJSON(geoData, {
        style: feature => {
            const normName = normalizeLGA(feature.properties.NAME_2);
            const lgaData = lgaMap[normName];
            let compIdx = lgaData ? lgaData.compIdx : 0;
            return { fillColor: getSafetyColour(compIdx), weight: 1, color: '#1a1a1a', fillOpacity: 0.85 };
        },
        onEachFeature: (feature, layer) => {
            const rawName = feature.properties.NAME_2;
            const normName = normalizeLGA(rawName);
            
            layer.bindTooltip(`${rawName}`, { permanent: true, direction: 'center', className: 'tableau-map-label' });
            
            layer.on({
                mouseover: (e) => {
                    if (selectedLga !== normName) e.target.setStyle({ weight: 2, color: '#ffffff' }).bringToFront();
                    
                    const lgaData = lgaMap[normName];
                    const tooltip = document.getElementById('map-hover-tooltip');
                    if (lgaData) {
                        tooltip.innerHTML = `
                            <div class="font-bold text-sm text-accentGreen mb-2 border-b border-gray-700 pb-1">${rawName}</div>
                            <div class="grid grid-cols-2 gap-x-6 gap-y-1">
                                <span class="text-gray-400">Safety Index:</span> <span class="font-mono font-bold text-right text-white">${lgaData.compIdx.toFixed(1)}</span>
                                <span class="text-gray-400">Violence %:</span> <span class="font-mono text-right text-white">${lgaData.pctViol.toFixed(1)}%</span>
                                <span class="text-gray-400">Tension %:</span> <span class="font-mono text-right text-white">${lgaData.pctTens.toFixed(1)}%</span>
                            </div>
                        `;
                        tooltip.classList.remove('hidden');
                    }
                },
                mousemove: (e) => {
                    const tt = document.getElementById('map-hover-tooltip');
                    tt.style.left = (e.originalEvent.clientX + 15) + 'px'; 
                    tt.style.top = (e.originalEvent.clientY + 15) + 'px';
                },
                mouseout: (e) => {
                    if (selectedLga !== normName) geojsonLayer.resetStyle(e.target);
                    document.getElementById('map-hover-tooltip').classList.add('hidden');
                },
                click: (e) => {
                    if (selectedLga === normName) {
                        geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l));
                        selectedLga = null;
                        document.getElementById('reset-view-btn').classList.add('hidden');
                        map.flyToBounds(geojsonLayer.getBounds(), getMapPadding());
                    } else {
                        geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l));
                        selectedLga = normName;
                        e.target.setStyle({ weight: 3, color: '#FFD700', fillOpacity: 1 }).bringToFront();
                        document.getElementById('reset-view-btn').classList.remove('hidden');
                        map.flyToBounds(e.target.getBounds(), { paddingBottomRight: getMapPadding().paddingBottomRight, paddingTopLeft: getMapPadding().paddingTopLeft, maxZoom: 12 });
                    }
                    updateRightPanel(); 
                }
            });
        }
    }).addTo(map);
    
    if (geoData.features.length > 0) map.fitBounds(geojsonLayer.getBounds(), getMapPadding());
}

function updateUI() {
    const allLagos = aggregateAll();
    
    document.getElementById('kpi-avg-safety').innerText = allLagos.avgSafe.toFixed(1);
    document.getElementById('kpi-violence').innerText = `${allLagos.pctViol.toFixed(1)}%`;
    document.getElementById('kpi-tensions').innerText = `${allLagos.pctTens.toFixed(1)}%`;
    document.getElementById('kpi-composite').innerText = allLagos.compIdx.toFixed(1);
    
    document.getElementById('kpi-avg-safety').style.color = getSafetyColour(allLagos.compIdx);
    document.getElementById('kpi-composite').style.color = getSafetyColour(allLagos.compIdx);
    
    updateRightPanel();
}

function updateRightPanel() {
    const data = (selectedLga && lgaMap[selectedLga]) ? lgaMap[selectedLga] : aggregateAll();
    
    document.getElementById('panel-lga-name').innerText = data.originalName ? data.originalName.toUpperCase() : "ALL LAGOS (AGGREGATED)";
    document.getElementById('panel-responses').innerText = `${data.total.toLocaleString()} RESPONSES ANALYZED`;

    const statewideDiv = document.getElementById('statewide-rankings');
    const lgaDiv = document.getElementById('lga-specific-sentiment');
    if (selectedLga) {
        statewideDiv.classList.add('hidden');
        lgaDiv.classList.remove('hidden');
    } else {
        statewideDiv.classList.remove('hidden');
        lgaDiv.classList.add('hidden');
    }

    let tier = "UNSAFE"; let tCol = '#d73027';
    if(data.avgSafe >= 4) { tier = "SAFE"; tCol = '#1a9850'; }
    else if(data.avgSafe >= 3) { tier = "MODERATE"; tCol = '#fee08b'; }
    
    document.getElementById('kpi-tier').innerText = tier;
    document.getElementById('kpi-tier').style.color = tCol;

    let maxMood = 0, topMood = "-";
    for(let m in data.moodCounts) { if(data.moodCounts[m] > maxMood) { maxMood = data.moodCounts[m]; topMood = m; } }
    document.getElementById('kpi-top-mood').innerText = topMood;
    document.getElementById('kpi-top-mood').style.color = topMood === 'calm' ? '#1a9850' : (topMood === 'tense' ? '#d73027' : '#fee08b');

    renderCharts(data);
}

Chart.register(ChartDataLabels);

function renderCharts(data) {
    const donutOpts = {
        responsive: true, maintainAspectRatio: false, cutout: '65%', borderWidth: 0,
        plugins: { 
            legend: { display: true, position: 'bottom', labels: {color: '#ccc', boxWidth: 10, font:{size: 10}} },
            datalabels: { color: '#fff', font: {weight: 'bold', size: 11}, formatter: (v, ctx) => {
                let sum = 0; ctx.chart.data.datasets[0].data.forEach(d => sum+=d);
                if(sum===0) return ''; return v > 0 ? Math.round((v*100)/sum)+'%' : '';
            }}
        }
    };

    if(charts.violence) charts.violence.destroy();
    charts.violence = new Chart(document.getElementById('violenceChart'), {
        type: 'doughnut',
        data: { labels: ['Yes', 'No'], datasets: [{ data: [data.violCounts.yes, data.violCounts.no], backgroundColor: ['#d73027', '#1a9850'] }] },
        options: donutOpts
    });

    if(charts.tension) charts.tension.destroy();
    charts.tension = new Chart(document.getElementById('tensionChart'), {
        type: 'doughnut',
        data: { labels: ['Yes', 'No'], datasets: [{ data: [data.tensCounts.yes, data.tensCounts.no], backgroundColor: ['#fc8d59', '#1a9850'] }] },
        options: donutOpts
    });

    if (!selectedLga) {
        let lgaArray = Object.values(lgaMap).filter(l => l.total > 0);
        
        // 1. Safety Ranking 
        lgaArray.sort((a, b) => b.compIdx - a.compIdx);
        
        if(charts.rankingSafety) charts.rankingSafety.destroy();
        charts.rankingSafety = new Chart(document.getElementById('rankingSafetyChart'), {
            type: 'bar',
            data: { 
                labels: lgaArray.map(l => l.originalName.toUpperCase()), 
                datasets: [{ 
                    data: lgaArray.map(l => l.compIdx), 
                    backgroundColor: lgaArray.map(l => getSafetyColour(l.compIdx)), 
                    borderRadius: 2 
                }] 
            },
            options: { 
                indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 30 } },
                plugins: { legend: { display: false }, datalabels: { color: '#fff', anchor: 'end', align: 'right', font: {size: 10, weight: 'bold'}, formatter: v => v.toFixed(1) } },
                scales: { x: { grid: { display: false }, ticks: { display: false }, max: 110 }, y: { grid: { display: false }, ticks: { color: '#ccc', font: {size: 10} } } }
            }
        });

        // 2. Hotspots Ranking
        lgaArray.sort((a, b) => b.pctViol - a.pctViol);

        if(charts.rankingHotspots) charts.rankingHotspots.destroy();
        charts.rankingHotspots = new Chart(document.getElementById('rankingHotspotsChart'), {
            type: 'bar',
            data: { 
                labels: lgaArray.map(l => l.originalName.toUpperCase()), 
                datasets: [
                    { label: '% Witnessed Violence', data: lgaArray.map(l => l.pctViol), backgroundColor: '#d73027', borderRadius: 2 },
                    { label: '% Noticed Tensions', data: lgaArray.map(l => l.pctTens), backgroundColor: '#fc8d59', borderRadius: 2 }
                ] 
            },
            options: { 
                indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 40 } },
                plugins: { legend: { display: true, position: 'top', labels: {color: '#ccc', boxWidth: 10, font: {size: 10}} }, datalabels: { color: '#fff', font: {size: 10, weight: 'bold'}, anchor: 'end', align: 'right', formatter: v => v > 0 ? Math.round(v) + '%' : '' } },
                scales: { x: { grid: { display: false }, ticks: { display: false }, max: 110 }, y: { grid: { display: false }, ticks: { color: '#ccc', font: {size: 10} } } }
            }
        });

    } else {
        if(charts.safety) charts.safety.destroy();
        // FIX: Updated exact text matching array
        let safeOrder = ['very_unsafe', 'somewhat_unsafe', 'neutral', 'somewhat_safe', 'very_safe', 'not_sure'];
        let safeData = safeOrder.map(k => data.safetyCounts[k] || 0);
        charts.safety = new Chart(document.getElementById('safetyChart'), {
            type: 'bar',
            data: { labels: safeOrder.map(k => k.replace('_',' ').toUpperCase()), datasets: [{ data: safeData, backgroundColor: '#4472C4', borderRadius: 2 }] },
            options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 30 } }, plugins: { legend: { display: false }, datalabels: { color: '#fff', anchor: 'end', align: 'right', font: {size: 10, weight: 'bold'}, formatter: v => v > 0 ? v : '' } }, scales: { x: { grid: { display: false }, ticks: { display: false } }, y: { grid: { display: false }, ticks: { color: '#ccc', font: {size: 10} } } } }
        });

        if(charts.mood) charts.mood.destroy();
        
        let moodEntries = Object.entries(data.moodCounts).filter(e => e[1] > 0).sort((a,b) => b[1] - a[1]);
        let moodTreeData = moodEntries.map(e => ({ name: e[0].toUpperCase(), value: e[1] }));

        charts.mood = new Chart(document.getElementById('moodChart'), {
            type: 'treemap',
            data: {
                datasets: [{
                    tree: moodTreeData,
                    key: 'value',
                    groups: ['name'],
                    backgroundColor: '#4472C4',
                    borderColor: '#1a1a1a', 
                    borderWidth: 2,
                    labels: {
                        display: true,
                        color: '#ffffff',
                        font: { size: 11, weight: 'bold' },
                        formatter: (ctx) => ctx.raw.v > 0 ? [ctx.raw.g, ctx.raw.v] : ''
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    datalabels: { display: false }, // Turn off standard datalabels for the treemap
                    tooltip: {
                        callbacks: {
                            title: (items) => items[0].raw.g,
                            label: (item) => `Responses: ${item.raw.v}`
                        }
                    }
                }
            }
        });
    }
}

document.getElementById('reset-view-btn').addEventListener('click', (e) => {
    selectedLga = null;
    if(geojsonLayer) { geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l)); map.flyToBounds(geojsonLayer.getBounds(), getMapPadding()); }
    e.target.classList.add('hidden'); updateRightPanel();
});

document.getElementById('recenter-map-btn').addEventListener('click', () => {
    if(map && geojsonLayer) map.flyToBounds(geojsonLayer.getBounds(), getMapPadding());
});

function simulateDashboardSwitch(dashboardName) {
    const overlay = document.getElementById('loader-overlay');
    const bar = document.getElementById('loader-bar');
    const text = document.getElementById('loader-text');
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.opacity = '1', 10); 
    bar.style.width = '10%'; text.innerText = `Routing to ${dashboardName}...`;
    setTimeout(() => { overlay.style.opacity = '0'; setTimeout(() => { overlay.style.display = 'none'; }, 700); }, 1000);
}

async function bootSequence() {
    const overlay = document.getElementById('loader-overlay');
    const bar = document.getElementById('loader-bar');
    const text = document.getElementById('loader-text');

    const updateProgress = (pct, msg) => { bar.style.width = pct + '%'; text.innerText = msg; };

    try {
        updateProgress(15, 'Connecting to database...');
        await loadData(); 
        
        updateProgress(50, 'Processing threat metrics...');
        await new Promise(r => setTimeout(r, 400)); 

        updateProgress(75, 'Loading map geometries...');
        await initMap();

        updateProgress(100, 'Rendering security dashboard...');
        await new Promise(r => setTimeout(r, 500));

        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 700);
        
        setInterval(async () => { try { await loadData(); } catch(e) {} }, 300000); 
    } catch (error) {
        bar.style.backgroundColor = '#d73027'; 
        bar.style.boxShadow = '0 0 10px #d73027';
        text.style.color = '#ff6b6b';
        text.innerText = `SYSTEM HALTED: ${error.message}`;
    }
}

window.onload = bootSequence;