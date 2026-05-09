let rawData = []; 
let lgaMap = {}; 
let map; 
let geojsonLayer; 
let selectedLga = null;

let charts = { 
    violence: null, 
    tension: null, 
    safety: null, 
    mood: null 
};

// Strict Whitelist
const VALID_LGAS = new Set([
    "agege", "ajeromiifelodun", "alimosho", "amuwoodofin", "apapa",
    "badagry", "epe", "etiosa", "ibejulekki", "ifakoijaiye", "ifakoijaye", 
    "ikeja", "ikorodu", "kosofe", "lagosisland", "lagosmainland", "mainland", 
    "mushin", "ojo", "oshodiisolo", "shomolu", "surulere"
]);

function normalizeLGA(name) { 
    if (!name) return "";
    let n = name.toLowerCase().replace(/[- \/]/g, ""); 
    return n === "mainland" ? "lagosmainland" : n; 
}

// Red to Green based on Safety Index (0-100)
function getSafetyColour(index) {
    if (index >= 75) return '#1a9850'; // Safe
    if (index >= 50) return '#fee08b'; // Moderate
    return '#d73027';                  // Unsafe
}

function getMapPadding() {
    const rightPanelWidth = window.innerWidth > 1024 ? (window.innerWidth * 0.40) + 40 : 20;
    return { paddingTopLeft: [20, 160], paddingBottomRight: [rightPanelWidth, 20] };
}

async function loadData() {
    let allData = [];
    let offset = 0;
    const limit = 1000; 
    let keepFetching = true;

    try {
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
    } catch (error) {
        console.warn("Database fetch failed. Using generated mock data.", error);
        rawData = getMockData(); // Fallback for testing
    }
    
    processData();
    updateUI();
    document.getElementById('last-sync-time').innerText = `Last Sync: ${new Date().toLocaleTimeString()}`;
}

function getMockData() {
    const lgas = Array.from(VALID_LGAS).slice(0, 20);
    let d = [];
    lgas.forEach(l => {
        for(let i=0; i<150; i++) {
            let s = Math.floor(Math.random() * 5) + 1; // 1-5
            d.push({
                lga_normalized: l,
                safety_score_num: s,
                violence_witnessed_binary: Math.random() > 0.8 ? 1 : 0,
                tensions_noticed_binary: Math.random() > 0.6 ? 1 : 0,
                is_calm_binary: Math.random() > 0.5 ? 1 : 0,
                safety_feeling: ['very_unsafe', 'unsafe', 'neutral', 'safe', 'very_safe'][s-1],
                community_mood: ['calm', 'tense', 'fearful', 'apathetic', 'excited'][Math.floor(Math.random()*5)]
            });
        }
    });
    return d;
}

function processData() {
    lgaMap = {};
    rawData.forEach(r => {
        const n = normalizeLGA(r.lga_normalized); 
        if(!n || !VALID_LGAS.has(n)) return; 
        
        if (!lgaMap[n]) {
            lgaMap[n] = {
                originalName: r.lga_normalized || r.lga_name,
                total: 0, sumSafety: 0, sumViol: 0, sumTens: 0, sumCalm: 0,
                safetyCounts: {}, moodCounts: {}, violCounts: {yes:0, no:0}, tensCounts: {yes:0, no:0}
            };
        }
        const l = lgaMap[n];
        l.total++;
        l.sumSafety += (r.safety_score_num || 0);
        l.sumViol += (r.violence_witnessed_binary || 0);
        l.sumTens += (r.tensions_noticed_binary || 0);
        l.sumCalm += (r.is_calm_binary || 0);
        
        if(r.safety_feeling) l.safetyCounts[r.safety_feeling] = (l.safetyCounts[r.safety_feeling] || 0) + 1;
        if(r.community_mood) l.moodCounts[r.community_mood] = (l.moodCounts[r.community_mood] || 0) + 1;
        if(r.violence_witnessed_binary === 1) l.violCounts.yes++; else l.violCounts.no++;
        if(r.tensions_noticed_binary === 1) l.tensCounts.yes++; else l.tensCounts.no++;
    });

    // Calculate Indexes per LGA
    Object.values(lgaMap).forEach(l => {
        l.avgSafe = l.total > 0 ? (l.sumSafety / l.total) : 0;
        l.pctViol = l.total > 0 ? (l.sumViol / l.total) * 100 : 0;
        l.pctTens = l.total > 0 ? (l.sumTens / l.total) * 100 : 0;
        l.compIdx = ((l.avgSafe/5)*100) * (1 - (l.pctViol/100)) * (1 - (l.pctTens/100));
    });
}

function aggregateAll() {
    let t=0, ss=0, sv=0, st=0, sc=0;
    let sfc={}, mc={}, vc={yes:0, no:0}, tc={yes:0, no:0};

    Object.values(lgaMap).forEach(l => {
        t += l.total; ss += l.sumSafety; sv += l.sumViol; st += l.sumTens; sc += l.sumCalm;
        for(let k in l.safetyCounts) sfc[k] = (sfc[k]||0) + l.safetyCounts[k];
        for(let k in l.moodCounts) mc[k] = (mc[k]||0) + l.moodCounts[k];
        vc.yes += l.violCounts.yes; vc.no += l.violCounts.no;
        tc.yes += l.tensCounts.yes; tc.no += l.tensCounts.no;
    });
    
    let avgSafe = t > 0 ? (ss/t) : 0;
    let pctViol = t > 0 ? (sv/t)*100 : 0;
    let pctTens = t > 0 ? (st/t)*100 : 0;
    let compIdx = ((avgSafe/5)*100) * (1 - (pctViol/100)) * (1 - (pctTens/100));

    return { total: t, avgSafe, pctViol, pctTens, compIdx, safetyCounts: sfc, moodCounts: mc, violCounts: vc, tensCounts: tc, originalName: null };
}

function updateUI() {
    const agg = aggregateAll();
    
    // Top KPI Bar Updates
    document.getElementById('kpi-avg-safety').innerText = agg.avgSafe.toFixed(1);
    
    const elViol = document.getElementById('kpi-violence');
    elViol.innerText = agg.pctViol.toFixed(1) + '%';
    elViol.style.color = agg.pctViol > 20 ? '#d73027' : '#fee08b'; // Red if high violence
    
    document.getElementById('kpi-tensions').innerText = agg.pctTens.toFixed(1) + '%';
    
    const elComp = document.getElementById('kpi-composite');
    elComp.innerText = agg.compIdx.toFixed(1);
    elComp.style.color = getSafetyColour(agg.compIdx);

    updateRightPanel();
}

function updateRightPanel() {
    const data = (selectedLga && lgaMap[selectedLga]) ? lgaMap[selectedLga] : aggregateAll();
    
    document.getElementById('panel-lga-name').innerText = data.originalName ? data.originalName.toUpperCase() : "ALL LAGOS (AGGREGATED)";
    document.getElementById('panel-responses').innerText = `${data.total.toLocaleString()} RESPONSES ANALYZED`;

    let tier = "UNSAFE"; let tCol = '#d73027';
    if(data.compIdx >= 75) { tier = "SAFE"; tCol = '#1a9850'; }
    else if(data.compIdx >= 50) { tier = "MODERATE"; tCol = '#fee08b'; }
    
    document.getElementById('kpi-tier').innerText = tier;
    document.getElementById('kpi-tier').style.color = tCol;

    let maxMood = "-", maxV = 0;
    for(let k in data.moodCounts) { if(data.moodCounts[k] > maxV) { maxV = data.moodCounts[k]; maxMood = k; } }
    document.getElementById('kpi-top-mood').innerText = maxMood;

    renderCharts(data);
}

Chart.register(ChartDataLabels);

function renderCharts(data) {
    const donutOpts = {
        responsive: true, maintainAspectRatio: false, cutout: '60%', borderWidth: 1, borderColor: '#2a2a2a',
        plugins: {
            legend: { position: 'bottom', labels: { color: '#ccc', font: {size: 10} } },
            datalabels: { 
                color: '#fff', font: {weight: 'bold', size: 12}, 
                formatter: (v, ctx) => { 
                    let sum=0; ctx.chart.data.datasets[0].data.forEach(d=>sum+=d); 
                    return v>0 ? Math.round(v*100/sum)+"%" : ""; 
                } 
            }
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

    if(charts.safety) charts.safety.destroy();
    let safeOrder = ['very_unsafe', 'unsafe', 'neutral', 'safe', 'very_safe'];
    let safeData = safeOrder.map(k => data.safetyCounts[k] || 0);
    charts.safety = new Chart(document.getElementById('safetyChart'), {
        type: 'bar',
        data: { labels: safeOrder.map(k=>k.replace('_',' ').toUpperCase()), datasets: [{ data: safeData, backgroundColor: '#4472C4', borderRadius: 2 }] },
        options: { 
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { 
                legend: { display: false }, 
                datalabels: { color: '#fff', anchor: 'end', align: 'right', font: {size: 10} } 
            },
            scales: { 
                x: { grid: { display: false }, ticks: { display: false } }, 
                y: { grid: { display: false }, ticks: { color: '#ccc', font: {size: 10} } } 
            },
            layout: { padding: { right: 35 } }
        }
    });

    if(charts.mood) charts.mood.destroy();
    let moodArr = Object.entries(data.moodCounts).map(e => ({ name: e[0].toUpperCase(), value: e[1] }));
    charts.mood = new Chart(document.getElementById('moodChart'), {
        type: 'treemap',
        data: { datasets: [{ tree: moodArr, key: 'value', groups: ['name'], backgroundColor: '#4472C4', borderColor: '#1a1a1a', borderWidth: 2,
            labels: { display: true, color: '#fff', font: { size: 11, weight: 'bold' }, formatter: (ctx) => ctx.raw.v > 0 ? [ctx.raw.g, ctx.raw.v] : '' }
        }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, datalabels: { display: false } } }
    });
}

async function initMap() {
    map = L.map('map', { zoomControl: false }).setView([6.5244, 3.3792], 10);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 }).addTo(map);

    function adjustMapLabels() {
        const z = map.getZoom();
        const m = document.getElementById('map');
        if (z < 10) m.classList.add('hide-labels');
        else {
            m.classList.remove('hide-labels');
            m.style.setProperty('--dynamic-label-size', `${Math.min(1.1, 0.55 + ((z - 10) * 0.15))}rem`);
        }
    }
    adjustMapLabels(); map.on('zoomend', adjustMapLabels);

    let geoData;
    try {
        const response = await fetch(CONFIG.GEOJSON_URL);
        if (!response.ok) throw new Error("Local GeoJSON not found.");
        const rawGeo = await response.json();
        geoData = { type: "FeatureCollection", features: rawGeo.features.filter(f => f.properties.NAME_1 && f.properties.NAME_1.trim().toLowerCase() === "lagos") };
    } catch (e) {
        console.warn("Using fallback GeoJSON", e);
        // Fallback for rendering purposes if missing
        geoData = { type: "FeatureCollection", features: [
            {type:"Feature", properties:{NAME_2:"Alimosho"}, geometry:{type:"Polygon", coordinates:[[[3.2, 6.6], [3.3, 6.6], [3.3, 6.5], [3.2, 6.5], [3.2, 6.6]]]}},
            {type:"Feature", properties:{NAME_2:"Ikeja"}, geometry:{type:"Polygon", coordinates:[[[3.3, 6.6], [3.4, 6.6], [3.4, 6.5], [3.3, 6.5], [3.3, 6.6]]]}}
        ]};
    }

    geojsonLayer = L.geoJSON(geoData, {
        style: f => {
            const n = normalizeLGA(f.properties.NAME_2);
            const idx = lgaMap[n] ? lgaMap[n].compIdx : 0;
            return { fillColor: getSafetyColour(idx), weight: 1, color: '#1a1a1a', fillOpacity: 0.85 };
        },
        onEachFeature: (f, layer) => {
            const rawName = f.properties.NAME_2;
            const normName = normalizeLGA(rawName);
            layer.bindTooltip(rawName, { permanent: true, direction: 'center', className: 'tableau-map-label' });
            
            layer.on({
                mouseover: (e) => {
                    if (selectedLga !== normName) e.target.setStyle({ weight: 2, color: '#ffffff' }).bringToFront();
                    const d = lgaMap[normName];
                    const tt = document.getElementById('map-hover-tooltip');
                    if(d) {
                        tt.innerHTML = `
                            <div class="font-bold text-sm text-accentGreen mb-2 border-b border-gray-700 pb-1">${rawName.toUpperCase()}</div>
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                                <span class="text-gray-400">Safety Index:</span> <span class="font-mono text-right font-bold" style="color:${getSafetyColour(d.compIdx)}">${d.compIdx.toFixed(1)}</span>
                                <span class="text-gray-400">Violence:</span> <span class="font-mono text-right text-white">${d.pctViol.toFixed(1)}%</span>
                                <span class="text-gray-400">Tensions:</span> <span class="font-mono text-right text-white">${d.pctTens.toFixed(1)}%</span>
                            </div>
                        `;
                        tt.classList.remove('hidden');
                    }
                },
                mousemove: (e) => {
                    const tt = document.getElementById('map-hover-tooltip');
                    tt.style.left = (e.containerPoint.x + 15) + 'px'; tt.style.top = (e.containerPoint.y + 15) + 'px';
                },
                mouseout: (e) => {
                    if (selectedLga !== normName) geojsonLayer.resetStyle(e.target);
                    document.getElementById('map-hover-tooltip').classList.add('hidden');
                },
                click: (e) => {
                    geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l));
                    if (selectedLga === normName) {
                        selectedLga = null; document.getElementById('reset-view-btn').classList.add('hidden');
                        map.flyToBounds(geojsonLayer.getBounds(), getMapPadding());
                    } else {
                        selectedLga = normName; e.target.setStyle({ weight: 3, color: '#FFD700', fillOpacity: 1 }).bringToFront();
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

document.getElementById('reset-view-btn').addEventListener('click', (e) => {
    selectedLga = null;
    if(geojsonLayer) { geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l)); map.flyToBounds(geojsonLayer.getBounds(), getMapPadding()); }
    e.target.classList.add('hidden'); updateRightPanel();
});
document.getElementById('recenter-map-btn').addEventListener('click', () => { if(map && geojsonLayer) map.flyToBounds(geojsonLayer.getBounds(), getMapPadding()); });

async function bootSequence() {
    const overlay = document.getElementById('loader-overlay');
    const bar = document.getElementById('loader-bar');
    const text = document.getElementById('loader-text');
    
    try {
        bar.style.width = '20%'; text.innerText = 'Connecting to intelligence database...';
        await loadData();
        
        bar.style.width = '70%'; text.innerText = 'Analyzing sentiment geometry...';
        await initMap();
        
        bar.style.width = '100%'; text.innerText = 'Rendering dashboard...';
        await new Promise(r => setTimeout(r, 500));
        
        overlay.style.opacity = '0';
        setTimeout(() => overlay.style.display = 'none', 700);
    } catch (e) {
        bar.style.backgroundColor = '#d73027'; 
        text.style.color = '#ff6b6b';
        text.innerText = `SYSTEM HALTED: ${e.message}`;
    }
}
window.onload = bootSequence;