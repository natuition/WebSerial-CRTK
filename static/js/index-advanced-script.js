/* ========================================
    Configurateur NavX - JavaScript for index_advanced.html (advanced mode, desktop only)
    ======================================== */

// The advanced page is desktop only: phones go back to the beginner page
if (isPhoneDevice()) {
    window.location.replace('index.html');
}

// Bascule Avancé -> Débutant
document.addEventListener('DOMContentLoaded', () => {
    const sw = document.getElementById('modeSwitch');
    if (!sw) return;
    // Sur la page Avancé, le toggle doit être en position "Avancé" (ON)
    sw.checked = true;
    sw.addEventListener('change', () => {
        if (!sw.checked) {
            // Revenir vers l’UI débutant
            window.location.href = 'index.html';
        }
    });
});

// Variables specific to advanced mode
const logEl = $('#log');
let advRecvBuffer = '';
let showNmea = false;
const MIN_INTER_COMMAND_DELAY_MS = 500;
// Keep the terminal light when NMEA is displayed for a long time
const MAX_LOG_LINES = 2000;
let waitAck = true;
let pendingReceivedResolvers = [];
// Single command line history (arrow up / down)
const singleCmdHistory = [];
let singleCmdHistoryIndex = -1;

/**
 * Wait for the next received line matching the RegExp (or string), with optional timeout.
 * Resolved by the read loop (notifyReceived) when a matching line arrives.
 */
function waitForReceivedMatching(regexOrStr, timeoutMs) {
    const re = (regexOrStr instanceof RegExp) ? regexOrStr : new RegExp(String(regexOrStr), 'i');
    return new Promise((resolve, reject) => {
        if (!reader) return reject(new Error('No reader available'));
        const id = Symbol('waiter');
        const timer = (typeof timeoutMs === 'number' && timeoutMs > 0) ? setTimeout(() => {
            pendingReceivedResolvers = pendingReceivedResolvers.filter(w => w.id !== id);
            reject(new Error('timeout'));
        }, timeoutMs) : null;
        pendingReceivedResolvers.push({ id, resolve, reject, timer, predicate: (m) => re.test(String(m)) });
    });
}

function notifyReceived(message) {
    if (!pendingReceivedResolvers.length) return;
    const idx = pendingReceivedResolvers.findIndex(w => {
        try { return !w.predicate || w.predicate(String(message)); } catch { return false; }
    });
    if (idx >= 0) {
        const waiter = pendingReceivedResolvers.splice(idx, 1)[0];
        try { clearTimeout(waiter.timer); } catch { }
        try { waiter.resolve(message); } catch { }
    }
}

function isNmeaLine(message) {
    return typeof message === 'string' && /^\$[A-Z]{5},/.test(message);
}

function updateTransportUi() {
    const transport = $('#transport')?.value || 'serial';
    const baudEl = $('#baud');
    if (baudEl) {
        baudEl.disabled = (transport === 'ble');
    }
    updateTransportIcons(transport);
}

/* ---------------------- UI Functions ---------------------- */
/**
 * Appends a terminal line. type: sent | received | info | warn | error
 */
function logLine(s, type = 'info') {
    const line = document.createElement('div');
    const time = new Date().toLocaleTimeString('fr-FR', { hour12: false });
    const prefix = type === 'sent' ? '→ ' : type === 'received' ? '← ' : '';
    line.innerHTML = `<span class="timestamp">[${time}]</span> <span class="${type}">${escapeHtml(prefix + (s ?? ''))}</span>`;
    logEl.appendChild(line);
    while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
    logEl.innerHTML = '';
}

function updateProgress(done, total) {
    $('#progressFill').style.width = (total ? (done / total) * 100 : 0) + '%';
    $('#progressText').textContent = `${done}/${total}`;
}

/* ---------------------- Event Handlers ---------------------- */
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize configuration list (populateConfigSelect logs the result itself)
    try {
        const result = await populateConfigSelect(false);
        if (!result?.[0]?.length) {
            logLine('Impossible de lister les configurations. Chargez un fichier personnel.', 'warn');
        }
    } catch (e) {
        logLine('✗ Erreur lors du chargement des configurations', 'error');
    }

    const transportSel = $('#transport');
    if (transportSel) {
        // USB and BLE have their own configuration folders (conf_files/usb, conf_files/ble)
        transportSel.addEventListener('change', () => {
            updateTransportUi();
            populateConfigSelect(false);
        });
        updateTransportUi();
    }

    const showNmeaEl = $('#showNmea');
    if (showNmeaEl) {
        showNmea = !!showNmeaEl.checked;
        showNmeaEl.addEventListener('change', () => {
            showNmea = !!showNmeaEl.checked;
            logLine(showNmea ? 'NMEA affiché' : 'NMEA masqué');
        });
    }

    const waitAckEl = $('#waitAck');
    if (waitAckEl) {
        waitAck = !!waitAckEl.checked;
        waitAckEl.addEventListener('change', () => {
            waitAck = !!waitAckEl.checked;
            logLine(waitAck ? 'Attente d’acquittement activée' : 'Attente d’acquittement désactivée');
        });
    }
});

// Configuration select
$('#configSelect').onchange = async (ev) => {
    const url = ev.target.value;
    if (!url) return;
    try {
        const result = await loadConfigFromUrl(url);
        $('#cmd').value = result.content;
        $('#configFile').value = '';
        logLine('✓ Configuration chargée : ' + url.split('/').pop());
    } catch (e) {
        logLine('✗ ' + e.message, 'error');
    }
};

// Personal file
$('#configFile').onchange = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
        const result = await loadConfigFromFile(f);
        $('#cmd').value = result.content;
        $('#configSelect').value = ''; // deselect conf_files menu
        logLine('✓ Fichier chargé : ' + result.filename);
    } catch (e) {
        logLine('✗ ' + e.message, 'error');
    }
};

/* ---------------------- Serial Communication ---------------------- */
$('#connect').onclick = async () => {
    try {
        const result = await connectTransport();

        // Read loop specific to advanced mode
        (async function readLoop() {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (!value) continue;
                    advRecvBuffer += value;
                    const parts = advRecvBuffer.split(/\r\n|\n/);
                    advRecvBuffer = parts.pop();
                    parts.forEach(p => {
                        if (!p.length) return;
                        notifyReceived(p);
                        handleNmeaForMap(p);
                        if (!showNmea && isNmeaLine(p)) return;
                        logLine(p, 'received');
                    });
                }
            } catch (e) {
                logLine('✗ Erreur de lecture : ' + e.message, 'error');
            }
        })();

        $('#connect').classList.add('hidden');
        $('#disconnect').classList.remove('hidden');
        $('#disconnect').disabled = false;
        if (result?.transport === 'ble') {
            setDeviceStatus(result.deviceName || 'Appareil Bluetooth');
            logLine(`✓ Connecté en Bluetooth (${result.deviceName || 'appareil'})`);
        } else {
            setDeviceStatus(`USB · ${result.baudRate} baud`);
            logLine(`✓ Connecté en USB à ${result.baudRate} bauds`);
        }
    } catch (e) {
        // Device chooser closed without selection: not an error
        if (e?.name === 'NotFoundError') {
            logLine('Aucun appareil sélectionné.');
            return;
        }
        logLine('✗ Erreur de connexion : ' + (e?.message || e), 'error');
    }
};

$('#disconnect').onclick = async () => {
    try {
        await disconnectTransport();

        $('#connect').classList.remove('hidden');
        $('#disconnect').classList.add('hidden');
        $('#disconnect').disabled = true;
        setDeviceStatus(null);
        resetMapPosition();
        logLine('Déconnecté');
    } catch (e) {
        logLine('✗ Erreur de déconnexion : ' + (e?.message || e), 'error');
    }
};

/* ---------------------- Send Commands ---------------------- */
$('#send').onclick = async () => {
    if (!writer) { logLine('✗ Non connecté.', 'error'); return; }
    if (sendingBatch) { logLine('Envoi déjà en cours, veuillez patienter…', 'warn'); return; }

    const raw = $('#cmd').value || '';
    let lines = raw.split('\n')
        .map(s => s.trim())
        .filter(s => s.length && !s.startsWith('#') && !s.startsWith('//') && !s.startsWith(';'));

    if (!lines.length) { logLine('Rien à envoyer.', 'warn'); return; }

    const delaySec = Math.max(0, parseFloat($('#delay').value || '5') || 5);
    const eol = getEOL();

    sendingBatch = true;
    $('#send').disabled = true;
    updateProgress(0, lines.length);
    try {
        logLine(`▶️ Envoi de ${lines.length} commande(s), délai ${delaySec} s…`);
        for (let i = 0; i < lines.length; i++) {
            const cmd = lines[i];
            if (cmd.trim().toUpperCase() === 'FRESET' && currentTransport === 'ble') {
                logLine(`⏭️ [${i + 1}/${lines.length}] FRESET ignoré en Bluetooth`, 'warn');
                updateProgress(i + 1, lines.length);
                await sleep(MIN_INTER_COMMAND_DELAY_MS);
                continue;
            }
            const nonNmeaPattern = /^(?!\$[A-Z]{5},).+/;
            const waiterPromise = (waitAck && delaySec > 0)
                ? waitForReceivedMatching(nonNmeaPattern, delaySec * 1000).catch(() => null)
                : null;

            await writer.write(cmd + eol);
            logLine(`[${i + 1}/${lines.length}] ${cmd}`, 'sent');

            const sleepPromise = sleep(MIN_INTER_COMMAND_DELAY_MS);
            if (waitAck) {
                // The waiter resolves to null on timeout
                const [, response] = await Promise.all([sleepPromise, waiterPromise]);
                if (waiterPromise && response === null) {
                    logLine(`⚠️ Pas de réponse après ${delaySec} s, on continue`, 'warn');
                }
            } else {
                await sleep(delaySec * 1000);
            }
            updateProgress(i + 1, lines.length);
        }
        logLine('✅ Envoi terminé.');
    } catch (e) {
        logLine('✗ Envoi interrompu : ' + (e?.message || e), 'error');
    } finally {
        sendingBatch = false;
        $('#send').disabled = false;
    }
};

$('#save').onclick = async () => {
    try {
        await sendSaveConfig();
        logLine('SAVECONFIG', 'sent');
    } catch (e) {
        logLine('✗ ' + e.message, 'error');
    }
};

$('#clear').onclick = () => clearLog();

// Single command line: Enter sends, arrow up / down browse the history
$('#singleCmdForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const input = $('#singleCmd');
    const cmd = input.value.trim();
    if (!cmd) return;
    if (!writer) { logLine('✗ Non connecté.', 'error'); return; }
    if (sendingBatch) { logLine('Envoi déjà en cours, veuillez patienter…', 'warn'); return; }
    try {
        await writer.write(cmd + getEOL());
        logLine(cmd, 'sent');
        if (singleCmdHistory[singleCmdHistory.length - 1] !== cmd) singleCmdHistory.push(cmd);
        singleCmdHistoryIndex = -1;
        input.value = '';
    } catch (e) {
        logLine('✗ ' + (e?.message || e), 'error');
    }
};

$('#singleCmd').addEventListener('keydown', (ev) => {
    if (!singleCmdHistory.length || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    if (ev.key === 'ArrowUp') {
        singleCmdHistoryIndex = (singleCmdHistoryIndex < 0)
            ? singleCmdHistory.length - 1
            : Math.max(0, singleCmdHistoryIndex - 1);
    } else if (singleCmdHistoryIndex >= 0) {
        singleCmdHistoryIndex++;
        if (singleCmdHistoryIndex >= singleCmdHistory.length) singleCmdHistoryIndex = -1;
    }
    ev.target.value = singleCmdHistoryIndex < 0 ? '' : singleCmdHistory[singleCmdHistoryIndex];
});

// Register service worker for offline / PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
    });
}
