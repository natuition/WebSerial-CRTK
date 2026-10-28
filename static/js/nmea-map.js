/* ========================================
   Configurateur NavX - Live position map (beginner mode, Bluetooth only)
   Shows a "Carte" button while valid NMEA GGA positions are received over BLE
   and the browser is online; the map (MapLibre) is loaded on first open.
   Only while the map is open: precision (GST) is read and RTK corrections are
   streamed from the Centipede-RTK NEAR4 mountpoint (NTRIP 2.0 proxied by nginx).
   ======================================== */

const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// Hide the button when no valid position was received for this long
const FIX_STALE_MS = 10000;
// NEAR4 picks the base from the GGA sent at connection: reconnect after moving this far
const NTRIP_RECONNECT_DISTANCE_M = 5000;
const NTRIP_RETRY_MS = 5000;
// Drop RTCM when BLE can't keep up (old corrections are useless anyway)
const RTCM_MAX_BACKLOG = 16384;
// Every 10 s, a queue above ~2-3 s of corrections is emptied so that BLE resyncs on fresh data
const RTCM_FLUSH_INTERVAL_MS = 10000;
const RTCM_FLUSH_THRESHOLD = 4096;

const FIX_TYPES = {
    1: { label: 'GPS autonome', color: '#6b7280' },
    2: { label: 'DGPS', color: '#0b84d8' },
    4: { label: 'RTK fixe', color: '#0c9042' },
    5: { label: 'RTK flottant', color: '#f59e0b' },
    6: { label: 'Estimé', color: '#6b7280' }
};

let lastFix = null;
let lastGgaLine = null;
let lastPrecision = null;
let ntrip = null;
// Last session, kept after an error so the banner can show it
let ntripStatus = null;
let staleTimer = null;
let posMap = null;
let posMarker = null;
let followPosition = true;
let maplibreLoading = null;

/**
 * Validates the NMEA checksum (BLE can deliver truncated or merged lines)
 */
function hasValidNmeaChecksum(line) {
    const m = /^\$([^*]+)\*([0-9A-F]{2})\s*$/i.exec(line);
    if (!m) return false;
    let sum = 0;
    for (let i = 0; i < m[1].length; i++) sum ^= m[1].charCodeAt(i);
    return sum === parseInt(m[2], 16);
}

/** ddmm.mmmm + hemisphere -> decimal degrees */
function nmeaToDegrees(value, hemi) {
    const v = parseFloat(value);
    if (!isFinite(v)) return NaN;
    const deg = Math.floor(v / 100) + (v % 100) / 60;
    return (hemi === 'S' || hemi === 'W') ? -deg : deg;
}

/**
 * Parses a GGA sentence, returns null when invalid or without fix
 */
function parseGga(line) {
    if (!/^\$[A-Z]{2}GGA,/.test(line) || !hasValidNmeaChecksum(line)) return null;
    const f = line.split('*')[0].split(',');
    const quality = parseInt(f[6], 10);
    if (!quality) return null;
    const lat = nmeaToDegrees(f[2], f[3]);
    const lon = nmeaToDegrees(f[4], f[5]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return {
        lat, lon, quality,
        sats: parseInt(f[7], 10),
        hdop: parseFloat(f[8]),
        alt: parseFloat(f[9])
    };
}

/**
 * Parses a GST sentence: 1-sigma errors (m) -> horizontal / vertical precision
 */
function parseGst(line) {
    if (!/^\$[A-Z]{2}GST,/.test(line) || !hasValidNmeaChecksum(line)) return null;
    const f = line.split('*')[0].split(',');
    const latErr = parseFloat(f[6]), lonErr = parseFloat(f[7]), altErr = parseFloat(f[8]);
    if (!isFinite(latErr) || !isFinite(lonErr)) return null;
    return { horizontal: Math.hypot(latErr, lonErr), vertical: altErr };
}

/**
 * Called by the read loop for every received line
 */
function handleNmeaForMap(line) {
    if (currentTransport !== 'ble') return;
    const mapOpen = isMapOpen();
    // Map closed: only GGA, to know whether to show the button
    const precision = mapOpen ? parseGst(line) : null;
    if (precision) {
        lastPrecision = precision;
        updateMapInfo();
        return;
    }
    const fix = parseGga(line);
    if (!fix) return;
    lastFix = fix;
    lastGgaLine = line.trim();
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => { lastFix = null; updateMapButton(); }, FIX_STALE_MS);
    updateMapButton();
    if (mapOpen) {
        updateMapPosition();
        reconnectNtripIfMoved();
    }
}

function isMapOpen() {
    return !!$('#mapModal')?.classList.contains('active');
}

/**
 * Forget the position (on disconnection)
 */
function resetMapPosition() {
    lastFix = null;
    lastGgaLine = null;
    lastPrecision = null;
    clearTimeout(staleTimer);
    updateMapButton();
    closeMapModal();
}

function updateMapButton() {
    $('#mapToggle')?.classList.toggle('hidden', !(lastFix && navigator.onLine && currentTransport === 'ble'));
}

function loadMaplibre() {
    if (window.maplibregl) return Promise.resolve();
    if (!maplibreLoading) {
        maplibreLoading = new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = MAPLIBRE_CSS;
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = MAPLIBRE_JS;
            js.onload = () => resolve();
            js.onerror = () => { maplibreLoading = null; reject(new Error('MapLibre load failed')); };
            document.head.appendChild(js);
        });
    }
    return maplibreLoading;
}

/* ---------------------- NTRIP corrections (map open only) ---------------------- */

/**
 * Streams RTCM from the caster (NTRIP 2.0 proxied by nginx at /ntrip/stream) to the receiver over BLE
 */
async function startNtrip() {
    if (ntrip || !lastGgaLine || !isMapOpen()) return;
    const n = {
        abort: new AbortController(),
        origin: { lat: lastFix.lat, lon: lastFix.lon },
        state: 'connecting',
        bytes: 0,
        dropped: 0,
        backlog: 0,
        // Incremented on flush: pieces queued before are skipped
        generation: 0,
        chain: Promise.resolve()
    };
    ntrip = ntripStatus = n;
    n.flushTimer = setInterval(() => {
        if (n.backlog > RTCM_FLUSH_THRESHOLD) {
            n.generation++;
            n.dropped += n.backlog;
        }
    }, RTCM_FLUSH_INTERVAL_MS);
    updateMapInfo();
    try {
        // Ntrip-GGA: the NEAR4 mountpoint selects the closest base from this position
        const resp = await fetch('/ntrip/stream',
            { headers: { 'Ntrip-GGA': lastGgaLine }, signal: n.abort.signal, cache: 'no-store' });
        if (!resp.ok) throw new Error(resp.status === 404 ? 'relay' : 'HTTP ' + resp.status);
        n.state = 'ok';
        updateMapInfo();
        const rd = resp.body.getReader();
        while (true) {
            const { value, done } = await rd.read();
            if (done) break;
            queueRtcm(n, value);
        }
        throw new Error('stream ended');
    } catch (e) {
        if (n.abort.signal.aborted) return;
        n.state = (e.message === 'relay') ? 'no-relay' : 'error';
        updateMapInfo();
        stopNtrip(n);
        // The relay is missing (static hosting): no retry
        if (n.state !== 'no-relay') setTimeout(startNtrip, NTRIP_RETRY_MS);
    }
}

function queueRtcm(n, bytes) {
    if (n.backlog + bytes.length > RTCM_MAX_BACKLOG) {
        n.dropped += bytes.length;
        return;
    }
    n.backlog += bytes.length;
    const generation = n.generation;
    n.chain = n.chain
        .then(() => writeRtcmUnlessStopped(n, bytes, generation))
        .catch(() => { n.dropped += bytes.length; })
        .finally(() => { n.backlog -= bytes.length; });
}

/**
 * Writes in BLE-sized pieces and stops as soon as the session is stopped (map closed)
 * or the queue was flushed: nothing queued is sent afterwards
 */
async function writeRtcmUnlessStopped(n, bytes, generation) {
    const BLE_CHUNK = 20;
    for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
        if (n.abort.signal.aborted || n.generation !== generation) return;
        const piece = bytes.subarray(i, i + BLE_CHUNK);
        await writeBleBytes(piece);
        n.bytes += piece.length;
    }
}

function stopNtrip(n = ntrip) {
    if (!n) return;
    clearInterval(n.flushTimer);
    n.abort.abort();
    if (ntrip === n) ntrip = null;
}

/** Distance in meters (equirectangular approximation, fine for a few km) */
function distanceMeters(a, b) {
    const rad = Math.PI / 180;
    const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    const y = (b.lat - a.lat) * rad;
    return Math.hypot(x, y) * 6371000;
}

/**
 * NEAR4 only sees the GGA sent at connection: reconnect to get a closer base after moving
 */
function reconnectNtripIfMoved() {
    if (!ntrip || ntrip.state !== 'ok' || !lastFix) return;
    if (distanceMeters(ntrip.origin, lastFix) < NTRIP_RECONNECT_DISTANCE_M) return;
    stopNtrip();
    startNtrip();
}

function correctionsLabel() {
    const n = ntripStatus;
    if (!n) return '–';
    if (n.state === 'connecting') return 'Connexion…';
    if (n.state === 'ok') return `NEAR4 · ${(n.bytes / 1024).toFixed(1)} Ko`;
    return n.state === 'no-relay' ? 'Relais indisponible' : 'Erreur, nouvel essai…';
}

/** Precision in mm (in m above 10 m) */
function formatPrecision(meters) {
    if (!isFinite(meters)) return '–';
    return meters < 10 ? `${Math.round(meters * 1000)} mm` : `${meters.toFixed(1)} m`;
}

function updateMapInfo() {
    const stats = $('#mapStats');
    if (!stats || !lastFix) return;
    const type = FIX_TYPES[lastFix.quality] || { label: `Qualité ${lastFix.quality}`, color: '#6b7280' };
    stats.innerHTML = `
        <span class="map-fix" style="--fix-color: ${type.color}">${escapeHtml(type.label)}</span>
        <span class="map-stat"><small>Satellites</small><strong>${isFinite(lastFix.sats) ? lastFix.sats : '–'}</strong></span>
        <span class="map-stat"><small>Précision H</small><strong>${formatPrecision(lastPrecision?.horizontal)}</strong></span>
        <span class="map-stat"><small>Précision V</small><strong>${formatPrecision(lastPrecision?.vertical)}</strong></span>
        <span class="map-stat"><small>Corrections RTK</small><strong>${escapeHtml(correctionsLabel())}</strong></span>
    `;
    posMarker?.getElement().style.setProperty('--fix-color', type.color);
}

function updateMapPosition() {
    if (!lastFix) return;
    updateMapInfo();
    if (!posMap) return;
    const lngLat = [lastFix.lon, lastFix.lat];
    posMarker.setLngLat(lngLat);
    if (followPosition) posMap.easeTo({ center: lngLat, duration: 500 });
}

async function openMapModal() {
    if (!lastFix) return;
    $('#mapModal').classList.add('active');
    updateMapInfo();
    startNtrip();
    try {
        await loadMaplibre();
    } catch (e) {
        $('#map').innerHTML = '<div class="map-error">Impossible de charger la carte (connexion internet ?)</div>';
        return;
    }
    followPosition = true;
    if (!posMap) {
        posMap = new maplibregl.Map({
            container: 'map',
            style: MAP_STYLE_URL,
            center: [lastFix.lon, lastFix.lat],
            zoom: 18,
            // "i" button instead of a 2-line credit band on small screens
            attributionControl: { compact: true }
        });
        posMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        // MapLibre opens the compact credit on load: keep it folded ("i" opens it)
        posMap.once('load', () => {
            posMap.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
        });
        // Stop following once the user moves the map ("Recentrer" resumes)
        posMap.on('dragstart', () => { followPosition = false; });
        const el = document.createElement('div');
        el.className = 'map-marker';
        posMarker = new maplibregl.Marker({ element: el }).setLngLat([lastFix.lon, lastFix.lat]).addTo(posMap);
    } else {
        // The container was hidden: let MapLibre measure it again
        posMap.resize();
        posMap.jumpTo({ center: [lastFix.lon, lastFix.lat] });
    }
    updateMapPosition();
}

function closeMapModal() {
    $('#mapModal')?.classList.remove('active');
    stopNtrip();
    ntripStatus = null;
    lastPrecision = null;
}

$('#mapToggle').onclick = openMapModal;
$('#closeMapModal').onclick = closeMapModal;
$('#mapModal').onclick = (e) => {
    if (e.target === $('#mapModal')) closeMapModal();
};
$('#mapRecenter').onclick = () => {
    followPosition = true;
    updateMapPosition();
};
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMapModal();
});
window.addEventListener('online', updateMapButton);
window.addEventListener('offline', updateMapButton);
