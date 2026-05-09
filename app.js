let rawData = [];
let lgaMap = {}; 
let map;
let geojsonLayer;
let selectedLga = null; 

let charts = {
    gender: null,
    pvc: null,
    age: null,     
    occ: null      
};

// --- STRICT LGA WHITELIST ---
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

function getColour(ratio) {
    if (ratio >= 1.0)  return '#1a9850'; 
    if (ratio >= 0.75) return '#fee08b'; 
    if (ratio >= 0.5)  return '#fc8d59'; 
    return '#d73027';                    
}

// Helper function to calculate padding so Lagos stays in the bottom-left viewport
function getMapPadding() {
    // Top Left padding clears the KPI cards. Bottom Right padding clears the Chart Panel.
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
        
        if (!response.ok) {
            throw new Error(`Database error (Status: ${response.status})`);
        }
        
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
                expected_target: r.expected_target || 200,
                lga_total_responses: 0,
                genderCounts: { male: 0, female: 0, pnts: 0 },
                pvcCounts: {},
                ageCounts: {},
                occCounts: {}
            };
        }
        
        const lga = lgaMap[normName];
        lga.lga_total_responses++;

        // Track demographics
        if(r.gender) lga.genderCounts[r.gender.toLowerCase()] = (lga.genderCounts[r.gender.toLowerCase()] || 0) + 1;
        if(r.has_pvc) lga.pvcCounts[r.has_pvc] = (lga.pvcCounts[r.has_pvc] || 0) + 1;
        if(r.age_range) lga.ageCounts[r.age_range] = (lga.ageCounts[r.age_range] || 0) + 1;
        if(r.occupation) lga.occCounts[r.occupation] = (lga.occCounts[r.occupation] || 0) + 1;
    });
}

async function initMap() {
    map = L.map('map', { zoomControl: false }).setView([6.5244, 3.3792], 10);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 20
    }).addTo(map);

    // --- Dynamic Text Scaling for Labels ---
    function adjustMapLabels() {
        const currentZoom = map.getZoom();
        const mapContainer = document.getElementById('map');
        
        if (currentZoom < 10) {
            mapContainer.classList.add('hide-labels');
        } else {
            mapContainer.classList.remove('hide-labels');
            let newSize = 0.55 + ((currentZoom - 10) * 0.15);
            if (newSize > 1.1) newSize = 1.1; 
            mapContainer.style.setProperty('--dynamic-label-size', `${newSize}rem`);
        }
    }
    adjustMapLabels();
    map.on('zoomend', adjustMapLabels);

    let geoData;
    try {
        const response = await fetch(CONFIG.GEOJSON_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const rawGeo = await response.json();
        
        geoData = {
            type: "FeatureCollection",
            features: rawGeo.features.filter(f => 
                f.properties.NAME_1 && f.properties.NAME_1.trim().toLowerCase() === "lagos"
            )
        };

        if (geoData.features.length === 0) {
            document.getElementById('map').innerHTML += `<div style="position:absolute; top:40%; width:100%; text-align:center; color:#ff6b6b; z-index:999; font-family:monospace; background:rgba(0,0,0,0.8); padding:10px;"><b>Data Mismatch:</b> File found, but no features matched NAME_1 = 'Lagos'.</div>`;
            return;
        }

    } catch (e) {
        console.error("Map Load Error:", e);
        document.getElementById('map').innerHTML += `<div style="position:absolute; top:40%; width:100%; text-align:center; color:#ff6b6b; z-index:999; font-family:monospace; background:rgba(0,0,0,0.8); padding:10px;"><b>File Not Found:</b> Could not load <i>${CONFIG.GEOJSON_URL}</i>.<br>Ensure the file is in your VS Code folder.</div>`;
        return;
    }

    geojsonLayer = L.geoJSON(geoData, {
        style: feature => {
            const normName = normalizeLGA(feature.properties.NAME_2);
            const lgaData = lgaMap[normName];
            let ratio = lgaData ? (lgaData.lga_total_responses / lgaData.expected_target) : 0;
            
            return { fillColor: getColour(ratio), weight: 1, color: '#1a1a1a', fillOpacity: 0.85 };
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
                        const total = lgaData.lga_total_responses;
                        const target = lgaData.expected_target;
                        const pctMale = total > 0 ? Math.round((lgaData.genderCounts.male || 0) / total * 100) : 0;
                        const pctFemale = total > 0 ? Math.round((lgaData.genderCounts.female || 0) / total * 100) : 0;

                        tooltip.innerHTML = `
                            <div class="font-bold text-sm text-accentGreen mb-2 border-b border-gray-700 pb-1">${rawName}</div>
                            <div class="grid grid-cols-2 gap-x-6 gap-y-1">
                                <span class="text-gray-400">Current:</span> <span class="font-mono font-bold text-right text-white">${total}</span>
                                <span class="text-gray-400">Target:</span> <span class="font-mono text-right text-white">${target}</span>
                                <span class="text-gray-400">Male:</span> <span class="font-mono text-right text-chartBlue">${pctMale}%</span>
                                <span class="text-gray-400">Female:</span> <span class="font-mono text-right text-orange-400">${pctFemale}%</span>
                            </div>
                        `;
                        tooltip.classList.remove('hidden');
                    }
                },
                mousemove: (e) => {
                    const tooltip = document.getElementById('map-hover-tooltip');
                    tooltip.style.left = (e.containerPoint.x + 15) + 'px';
                    tooltip.style.top = (e.containerPoint.y + 15) + 'px';
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
    document.getElementById('kpi-total-responses').innerText = rawData.length.toLocaleString();
    
    const activeLgas = Object.keys(lgaMap).length;
    document.getElementById('kpi-reporting-lgas').innerText = `${activeLgas} / 20`;

    let validMappedCount = 0;
    let leadingLgaName = "-", maxCount = -1, targetMetCount = 0;
    
    Object.values(lgaMap).forEach(lga => {
        validMappedCount += lga.lga_total_responses;
        
        if (lga.lga_total_responses > maxCount) { maxCount = lga.lga_total_responses; leadingLgaName = lga.originalName; }
        if (lga.lga_total_responses >= lga.expected_target) targetMetCount++;
    });

    document.getElementById('kpi-valid-responses').innerText = `${validMappedCount.toLocaleString()} MAPPED TO VALID LGAS`;
    document.getElementById('kpi-leading-lga').innerText = leadingLgaName;
    document.getElementById('kpi-leading-lga-count').innerText = maxCount > 0 ? `(${maxCount})` : '';
    document.getElementById('kpi-target-met').innerText = `${targetMetCount} / 20`;

    updateRightPanel();
}

function aggregateAllLagos() {
    let t = 0, tg = 0;
    let gc = {male:0, female:0, pnts:0}, pc = {}, ac = {}, oc = {};

    Object.values(lgaMap).forEach(l => {
        t += l.lga_total_responses; 
        tg += l.expected_target;
        for(let k in l.genderCounts) gc[k] = (gc[k]||0) + l.genderCounts[k];
        for(let k in l.pvcCounts) pc[k] = (pc[k]||0) + l.pvcCounts[k];
        for(let k in l.ageCounts) ac[k] = (ac[k]||0) + l.ageCounts[k];
        for(let k in l.occCounts) oc[k] = (oc[k]||0) + l.occCounts[k];
    });

    return {
        lga_total_responses: t, expected_target: tg,
        genderCounts: gc, pvcCounts: pc, ageCounts: ac, occCounts: oc
    };
}

function updateRightPanel() {
    let contextData = (selectedLga && lgaMap[selectedLga]) ? lgaMap[selectedLga] : aggregateAllLagos();
    document.getElementById('panel-lga-name').innerText = contextData.originalName || "All Lagos (Aggregated)";
    
    const target = contextData.expected_target || 1; 
    const actual = contextData.lga_total_responses || 0;
    const pct = Math.min(100, Math.round((actual / target) * 100));
    
    document.getElementById('panel-progress-text').innerText = `${actual.toLocaleString()} / ${target.toLocaleString()} (${pct}%)`;
    document.getElementById('panel-progress-bar').style.width = `${pct}%`;
    document.getElementById('panel-progress-bar').style.backgroundColor = getColour(actual/target);

    const pctFemale = actual > 0 ? ((contextData.genderCounts.female || 0) / actual * 100).toFixed(1) : 0;
    const pctMale = actual > 0 ? ((contextData.genderCounts.male || 0) / actual * 100).toFixed(1) : 0;
    
    let pvcYes = 0;
    Object.keys(contextData.pvcCounts).forEach(k => { if(k.toLowerCase() === 'yes') pvcYes += contextData.pvcCounts[k]; });
    const pctPvc = actual > 0 ? ((pvcYes / actual) * 100).toFixed(1) : 0;

    const getTop = (obj) => {
        let max = 0, top = "-";
        for(let k in obj) { if(obj[k] > max) { max = obj[k]; top = k; } }
        return top.replace(/_/g, ' ').toUpperCase();
    };

    document.getElementById('kpi-pct-female').innerText = `${pctFemale}%`;
    document.getElementById('kpi-pct-male').innerText = `${pctMale}%`;
    document.getElementById('kpi-pct-pvc').innerText = `${pctPvc}%`;
    document.getElementById('kpi-gap').innerText = Math.max(0, target - actual).toLocaleString();
    
    document.getElementById('kpi-top-age').innerText = getTop(contextData.ageCounts);
    document.getElementById('kpi-top-occ').innerText = getTop(contextData.occCounts);

    renderCharts(contextData);
}

Chart.register(ChartDataLabels); 

function renderCharts(data) {
    const bgBlue = '#4472C4';

    const doughnutOpts = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
            legend: { display: true, position: 'bottom', labels: { color: '#ccc', boxWidth: 10, font: {size: 10} } },
            datalabels: {
                color: '#ffffff',
                font: { weight: 'bold', size: 11 },
                formatter: (value, ctx) => {
                    let sum = 0;
                    ctx.chart.data.datasets[0].data.forEach(d => { sum += d; });
                    if (sum === 0) return '';
                    let percentage = Math.round((value * 100) / sum) + "%";
                    return value > 0 ? percentage : '';
                }
            }
        },
        cutout: '55%', 
        borderWidth: 1,
        borderColor: '#2a2a2a' 
    };

    const barOpts = { 
        indexAxis: 'y', 
        responsive: true, 
        maintainAspectRatio: false, 
        layout: { padding: { right: 35 } }, 
        plugins: { 
            legend: { display: false }, 
            datalabels: { 
                display: true,
                color: '#ffffff',
                anchor: 'end',
                align: 'right', 
                font: { size: 11, weight: 'bold' }
            } 
        }, 
        scales: { 
            x: { grid: { display: false }, ticks: { color: '#aaa', font: {size: 10} } }, 
            y: { grid: { display: false }, ticks: { color: '#ccc', font: {size: 11} } } 
        } 
    };

    if(charts.gender) charts.gender.destroy();
    charts.gender = new Chart(document.getElementById('genderChart'), { 
        type: 'doughnut', 
        data: { 
            labels: ['Female', 'Male', 'PNTS'], 
            datasets: [{ 
                data: [data.genderCounts?.female||0, data.genderCounts?.male||0, data.genderCounts?.pnts||0], 
                backgroundColor: ['#fc8d59', '#4472C4', '#999999'] 
            }] 
        }, 
        options: doughnutOpts 
    });

    if(charts.pvc) charts.pvc.destroy();
    charts.pvc = new Chart(document.getElementById('pvcChart'), { 
        type: 'doughnut', 
        data: { 
            labels: Object.keys(data.pvcCounts||{}).map(k => k.replace(/_/g, ' ').toUpperCase()), 
            datasets: [{ 
                data: Object.values(data.pvcCounts||{}), 
                backgroundColor: ['#1a9850', '#d73027', '#fee08b', '#999999'] 
            }] 
        }, 
        options: doughnutOpts 
    });

    if(charts.age) charts.age.destroy();
    charts.age = new Chart(document.getElementById('ageChart'), { 
        type: 'bar', 
        data: { 
            labels: Object.keys(data.ageCounts||{}).map(k=>k.replace(/_/g,' ').toUpperCase()), 
            datasets: [{ data: Object.values(data.ageCounts||{}), backgroundColor: bgBlue, borderRadius: 2 }] 
        }, 
        options: barOpts 
    });

    if(charts.occ) charts.occ.destroy();
    let occEntries = Object.entries(data.occCounts||{}).sort((a,b) => b[1] - a[1]).slice(0, 10); 
    
    const occTreeData = occEntries.map(e => ({ name: e[0].replace(/_/g,' ').toUpperCase(), value: e[1] }));

    charts.occ = new Chart(document.getElementById('occChart'), { 
        type: 'treemap', 
        data: { 
            datasets: [{ 
                tree: occTreeData,
                key: 'value',
                groups: ['name'],
                backgroundColor: bgBlue,
                borderColor: '#1a1a1a', 
                borderWidth: 2,
                labels: {
                    display: true,
                    color: '#ffffff',
                    font: { size: 10, weight: 'bold' },
                    formatter: (ctx) => ctx.raw.v > 0 ? [ctx.raw.g, ctx.raw.v] : '' 
                }
            }] 
        }, 
        options: { 
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: { display: false }, 
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

document.getElementById('reset-view-btn').addEventListener('click', (e) => {
    selectedLga = null;
    if(geojsonLayer) { geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l)); map.flyToBounds(geojsonLayer.getBounds(), getMapPadding()); }
    e.target.classList.add('hidden'); updateRightPanel();
});

document.getElementById('recenter-map-btn').addEventListener('click', () => {
    if(map && geojsonLayer) {
        map.flyToBounds(geojsonLayer.getBounds(), getMapPadding());
    }
});

function simulateDashboardSwitch(dashboardName) {
    const overlay = document.getElementById('loader-overlay');
    const bar = document.getElementById('loader-bar');
    const text = document.getElementById('loader-text');
    
    overlay.style.display = 'flex';
    setTimeout(() => overlay.style.opacity = '1', 10); 
    bar.style.width = '10%';
    text.innerText = `Routing to ${dashboardName}...`;

    setTimeout(() => {
        console.log(`Redirecting to the ${dashboardName} dashboard logic...`);
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 700);
    }, 1000);
}

async function bootSequence() {
    const overlay = document.getElementById('loader-overlay');
    const bar = document.getElementById('loader-bar');
    const text = document.getElementById('loader-text');

    const updateProgress = (pct, msg) => { 
        bar.style.width = pct + '%'; 
        text.innerText = msg; 
    };

    try {
        updateProgress(15, 'Connecting to database...');
        await loadData(); 
        
        updateProgress(50, 'Processing survey metrics...');
        await new Promise(r => setTimeout(r, 400)); 

        updateProgress(75, 'Loading map geometries...');
        await initMap();

        updateProgress(100, 'Rendering dashboard...');
        await new Promise(r => setTimeout(r, 500));

        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 700);
        
        setInterval(async () => {
            try { await loadData(); } catch(e) { console.error("Background sync failed:", e); }
        }, 300000); 

    } catch (error) {
        bar.style.backgroundColor = '#d73027'; 
        bar.style.boxShadow = '0 0 10px #d73027';
        text.style.color = '#ff6b6b';
        text.innerText = `SYSTEM HALTED: ${error.message}. Check network and config.`;
        console.error("Boot sequence failed:", error);
    }
}

window.onload = bootSequence;