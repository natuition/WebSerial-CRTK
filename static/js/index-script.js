/* ========================================
   Centipede-RTK Web Serial - JavaScript for index.html (beginner mode)
   ======================================== */

// Set config source for this page
window.CONFIG_SOURCE = 'user';

// bascule Débutant -> Avancé
document.addEventListener('DOMContentLoaded', () => {
    const sw = document.getElementById('modeSwitch');
    if (!sw) return;
    // Sur la page Débutant, le toggle doit être en position "Débutant" (OFF)
    sw.checked = false;
    sw.addEventListener('change', () => {
        if (sw.checked) {
            // Aller vers l’UI avancée
            window.location.href = 'index_advanced.html';
        }
    });
});

// Variables specific to beginner mode
let currentConfig = '';
let isConnected = false;
let terminalVisible = false;
// Buffer used to assemble complete incoming lines for the beginner terminal
let recvBuffer = '';
// Minimum delay after each command (ms)
const MIN_INTER_COMMAND_DELAY_MS = 500;
// Pending resolvers for the 'wait for next received message' feature
let pendingReceivedResolvers = [];

function isNmeaLine(message) {
    return typeof message === 'string' && /^\$[A-Z]{5},/.test(message);
}

/**
 * Show the connected device in the status pill (null = not connected)
 */
function setDeviceStatus(label) {
    const statusEl = $('#deviceStatus');
    const nameEl = $('#deviceName');
    if (nameEl) nameEl.textContent = label || 'Non connecté';
    if (statusEl) statusEl.classList.toggle('connected', !!label);
}

function updateTransportUi() {
    const transport = $('#transport')?.value || 'serial';
    const baudEl = $('#baud');
    if (baudEl) {
        baudEl.disabled = (transport === 'ble');
    }

    // Update transport icons
    const usbIcon = document.querySelector('.transport-icon.usb-icon');
    const bleIcon = document.querySelector('.transport-icon.ble-icon');
    if (usbIcon && bleIcon) {
        if (transport === 'serial') {
            usbIcon.style.display = 'block';
            bleIcon.style.display = 'none';
        } else {
            usbIcon.style.display = 'none';
            bleIcon.style.display = 'block';
        }
    }
}

/**
 * USB and BLE have their own configuration folders: reload the list on transport change
 * and drop a configuration selected from the previous list (a personal file is kept).
 */
async function reloadConfigsForTransport() {
    if ($('#configSelect')?.value) {
        currentConfig = '';
        $('#upload').disabled = true;
        displayConfigDescription(null);
    }
    await populateConfigSelect(false);
    await renderConfigSummaryTable();
}

/* ---------------------- UI Functions ---------------------- */
function updateStatus(message, type = 'info') {
    const statusEl = $('#status');
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
}

function showProgress(show = true) {
    const container = $('#progressContainer');
    if (show) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
        // Also hide terminal when hiding progress bar
        setTerminalVisible(false);
    }
}

/**
 * Progress bar + "done/total" command counter
 */
function updateProgress(done, total) {
    const percentage = total ? (done / total) * 100 : 0;
    $('#progressFill').style.width = percentage + '%';
    $('#progressText').textContent = `${done}/${total}`;
}

/**
 * Show/hide the UART terminal; the toggle becomes a red close button while it is shown
 */
function setTerminalVisible(visible) {
    terminalVisible = visible;
    $('#uartTerminal').classList.toggle('hidden', !visible);
    const toggle = $('#terminalToggle');
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(visible));
        toggle.title = visible ? 'Fermer le terminal UART' : 'Afficher le terminal UART';
    }
}

function toggleTerminal() {
    setTerminalVisible(!terminalVisible);
}

function addToTerminal(message, type = 'info') {
    const isNmea = (type === 'received' && isNmeaLine(message));
    const shouldRender = !(type === 'received' && sendingBatch && isNmea);
    if (!isNmea && shouldRender) {
        console.log(`[Terminal ${type}] ${message}`);
    }
    const terminal = $('#uartTerminal');
    const timestamp = new Date().toLocaleTimeString('fr-FR', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    });

    let prefix = '';
    let cssClass = '';

    switch (type) {
        case 'sent':
            prefix = '→ TX: ';
            cssClass = 'sent';
            break;
        case 'received':
            prefix = '← RX: ';
            cssClass = 'received';
            break;
        default:
            prefix = '• ';
            break;
    }

    if (shouldRender) {
        const line = document.createElement('div');
        line.innerHTML = `<span class="timestamp">[${timestamp}]</span> <span class="${cssClass}">${prefix}${escapeHtml(message)}</span>`;
        terminal.appendChild(line);

        // Auto-scroll to bottom
        terminal.scrollTop = terminal.scrollHeight;
    }

    // If a 'received' message arrives, resolve the first matching pending waiter (if any)
    if (type === 'received' && pendingReceivedResolvers.length) {
        const idx = pendingReceivedResolvers.findIndex(w => {
            try { return !w.predicate || w.predicate(String(message)); } catch { return false; }
        });
        if (idx >= 0) {
            const waiter = pendingReceivedResolvers.splice(idx, 1)[0];
            try { clearTimeout(waiter.timer); } catch { }
            try { waiter.resolve(message); } catch { }
        }
    }
}

function clearTerminal() {
    $('#uartTerminal').innerHTML = '';
}

function setConfigSummaryVisible(show) {
    const container = $('#configSummaryTableContainer');
    if (!container) return;
    if (show) container.classList.remove('hidden');
    else container.classList.add('hidden');
}

async function renderConfigSummaryTable() {
    const container = $('#configSummaryTableContainer');
    if (!container) return;

    if ($('#configSelect')?.value) {
        setConfigSummaryVisible(false);
        return;
    }

    setConfigSummaryVisible(true);
    container.innerHTML = '<div class="muted">Chargement des descriptions…</div>';

    const items = await tryFetchManifestJSON();
    if (!items || !items.length) {
        container.innerHTML = '<div class="muted">Aucune description disponible.</div>';
        return;
    }

    const rows = await Promise.all(items.map(async (it) => {
        try {
            const result = await loadConfigFromUrl(it.url);
            const desc = extractConfigDescription(result.content);
            return { label: it.name || it.url, group: it.group, desc };
        } catch {
            return { label: it.name || it.url, group: it.group, desc: null };
        }
    }));

    // Same "group" titles as the selector (manifest order), e.g. RTK / Fast static in BLE
    let currentGroup = null;
    const bodyHtml = rows.map(r => {
        let groupRow = '';
        if (r.group && r.group !== currentGroup) {
            currentGroup = r.group;
            groupRow = `<tr class="config-summary-group"><th colspan="2">${escapeHtml(r.group)}</th></tr>`;
        }
        const title = r.desc?.title ? `<div class="config-summary-desc-title">${escapeHtml(r.desc.title)}</div>` : '';
        const details = (r.desc?.details?.length)
            ? `<ul class="config-summary-desc-list">${r.desc.details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
            : '<span class="muted">—</span>';
        return `${groupRow}<tr><td>${escapeHtml(r.label)}</td><td>${title}${details}</td></tr>`;
    }).join('');

    container.innerHTML = `
        <table class="config-summary-table">
            <thead>
                <tr>
                    <th>Configuration</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                ${bodyHtml}
            </tbody>
        </table>
    `;
}

/* ---------------------- Welcome Message ---------------------- */
const WELCOME_HIDDEN_KEY = 'welcomeHidden';

/**
 * Return true when the user chose "Ne plus afficher ce message"
 */
function isWelcomeHiddenByUser() {
    try {
        return localStorage.getItem(WELCOME_HIDDEN_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function showWelcomeMessage() {
    // Vérifier si le message n'existe pas déjà
    if (document.getElementById('welcomeContainer')) {
        return;
    }

    // Créer le container de bienvenue
    const welcomeContainer = document.createElement('div');
    welcomeContainer.id = 'welcomeContainer';
    welcomeContainer.style.cssText = `
        background: linear-gradient(135deg, #0c9042 0%, #36b448 100%);
        color: white;
        padding: 20px;
        margin: 20px 0;
        border-radius: 10px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        animation: slideIn 0.5s ease-out;
        position: relative;
    `;

    // Ajouter le bouton de fermeture
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '×';
    closeButton.style.cssText = `
        position: absolute;
        top: 10px;
        right: 15px;
        background: none;
        border: none;
        color: white;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background-color 0.3s;
    `;

    closeButton.onmouseover = () => {
        closeButton.style.backgroundColor = 'rgba(255,255,255,0.2)';
    };

    closeButton.onmouseout = () => {
        closeButton.style.backgroundColor = 'transparent';
    };

    const closeWelcome = () => {
        welcomeContainer.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => {
            welcomeContainer.remove();
        }, 300);
    };
    closeButton.onclick = closeWelcome;

    // Contenu du message
    const content = document.createElement('div');
    content.innerHTML = `
        <h2 style="margin-top: 0; margin-bottom: 15px; color: #fff;">
            Bienvenue dans le Configurateur NavX
        </h2>
        <p style="margin-bottom: 12px; line-height: 1.6;">
            <strong>Configurateur NavX</strong> est un outil de configuration pour les récepteurs GNSS/RTK. 
            Il vous permet de configurer facilement vos équipements via une interface web moderne dont NavX.
        </p>
        <p style="margin-bottom: 12px; line-height: 1.6;">
            <strong>⚠️ Compatibilité :</strong> Cette application fonctionne uniquement sur <strong>Chrome/Chromium</strong> 
            en raison des limitations de l'API Web Serial.
        </p>
    `;

    // Bouton "Ne plus afficher" (mémorisé dans le navigateur)
    const hideForeverButton = document.createElement('button');
    hideForeverButton.textContent = 'Ne plus afficher ce message';
    hideForeverButton.style.cssText = `
        background: rgba(255,255,255,0.15);
        border: 1px solid rgba(255,255,255,0.6);
        color: white;
        padding: 8px 14px;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
        transition: background-color 0.3s;
    `;
    hideForeverButton.onmouseover = () => {
        hideForeverButton.style.backgroundColor = 'rgba(255,255,255,0.3)';
    };
    hideForeverButton.onmouseout = () => {
        hideForeverButton.style.backgroundColor = 'rgba(255,255,255,0.15)';
    };
    hideForeverButton.onclick = () => {
        try { localStorage.setItem(WELCOME_HIDDEN_KEY, '1'); } catch { }
        closeWelcome();
    };

    welcomeContainer.appendChild(closeButton);
    welcomeContainer.appendChild(content);
    welcomeContainer.appendChild(hideForeverButton);

    // Ajouter les animations CSS si elles n'existent pas
    if (!document.getElementById('welcomeStyles')) {
        const style = document.createElement('style');
        style.id = 'welcomeStyles';
        style.textContent = `
            @keyframes slideIn {
                from {
                    transform: translateY(-20px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }
            @keyframes slideOut {
                from {
                    transform: translateY(0);
                    opacity: 1;
                }
                to {
                    transform: translateY(-20px);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // Insérer avant le main-container
    const mainContainer = document.querySelector('.main-container') || document.querySelector('main') || document.body;
    mainContainer.parentNode.insertBefore(welcomeContainer, mainContainer);
}

/**
 * Return true when welcome message should be disabled via URL param
 * Example: ?disable_help=true or ?disable_help=1
 */
function isWelcomeDisabledByUrl() {
    try {
        const p = new URLSearchParams(window.location.search).get('disable_help');
        if (!p) return false;
        const v = String(p).toLowerCase();
        return (v === 'true' || v === '1' || v === 'yes');
    } catch (e) {
        return false;
    }
}

/**
 * Wait for the next received message (promise resolved by addToTerminal when a 'received' arrives)
 * If timeoutMs is provided, it rejects after timeout
 */
function waitForNextReceived(timeoutMs) {
    return new Promise((resolve, reject) => {
        // Guard: if there is no reader, reject immediately
        if (!reader) {
            return reject(new Error('No reader available'));
        }

        const id = Symbol('waiter');
        const timer = (typeof timeoutMs === 'number' && timeoutMs > 0) ? setTimeout(() => {
            // remove resolver
            pendingReceivedResolvers = pendingReceivedResolvers.filter(w => w.id !== id);
            reject(new Error('timeout'));
        }, timeoutMs) : null;

        pendingReceivedResolvers.push({ id, resolve, reject, timer, predicate: () => true });
    });
}

/**
 * Wait for the next received message that matches the provided RegExp (or string), with optional timeout
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

/**
 * Wait for a sequence of messages (each matched by a regex or string) in order.
 * Returns true if the full sequence matched within overallTimeoutMs, false otherwise.
 */
async function waitForSequence(patterns, overallTimeoutMs, perMessageTimeoutMs) {
    const start = Date.now();
    for (const pat of patterns) {
        const elapsed = Date.now() - start;
        const remaining = overallTimeoutMs ? Math.max(0, overallTimeoutMs - elapsed) : perMessageTimeoutMs;
        if (remaining <= 0) return false;
        try {
            await waitForReceivedMatching(pat, Math.min(perMessageTimeoutMs, remaining));
        } catch (e) {
            return false;
        }
    }
    return true;
}

/* ---------------------- Configuration Management ---------------------- */
function displayConfigDescription(description) {
    const container = $('#configDescriptionContainer');
    const descElement = $('#configDescription');

    if (!description) {
        container.style.display = 'none';
        return;
    }

    let html = '';
    if (description.title) {
        html += `<h4>${convertUrlsToLinks(escapeHtml(description.title))}</h4>`;
    }

    if (description.details.length > 0) {
        description.details.forEach(detail => {
            html += `<p>${convertUrlsToLinks(escapeHtml(detail))}</p>`;
        });
    }

    descElement.innerHTML = html;
    container.style.display = 'block';
}

/* ---------------------- Event Handlers ---------------------- */
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize configuration list (transport must be final first: the list depends on it)
    disableUsbOnMobile();
    try {
        const result = await populateConfigSelect(false);
        if (result[0].length > 0) {
            updateStatus(`${result[0].length} configuration(s) trouvée(s) (${result[1]})`, 'success');
        } else {
            updateStatus('Impossible de lister les configurations. Utilisez un fichier personnel (paramètres avancés).', 'info');
        }
        await renderConfigSummaryTable();
    } catch (e) {
        console.log(e);
        updateStatus('Erreur lors du chargement des configurations', 'error');
    }

    // Afficher le message de bienvenue après 500 ms (sauf si désactivé via ?disable_help=true)
    if (!isWelcomeDisabledByUrl() && !isWelcomeHiddenByUser()) {
        setTimeout(() => {
            showWelcomeMessage();
        }, 500);
    }

    const transportSel = $('#transport');
    if (transportSel) {
        transportSel.addEventListener('change', async () => {
            updateTransportUi();
            await reloadConfigsForTransport();
        });
        updateTransportUi();
    }
});

// Toggle settings modal
$('#settingsToggle').onclick = () => {
    const modal = $('#settingsModal');
    modal.classList.add('active');
};

// Toggle terminal
$('#terminalToggle').onclick = () => {
    toggleTerminal();
};

// Close modal
$('#closeModal').onclick = () => {
    const modal = $('#settingsModal');
    modal.classList.remove('active');
};

// Close modal when clicking on backdrop
$('#settingsModal').onclick = (e) => {
    if (e.target === $('#settingsModal')) {
        $('#settingsModal').classList.remove('active');
    }
};

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        $('#settingsModal').classList.remove('active');
    }
});

// Configuration select
$('#configSelect').onchange = async (ev) => {
    const url = ev.target.value;
    if (!url) {
        currentConfig = '';
        $('#upload').disabled = true;
        displayConfigDescription(null);
        await renderConfigSummaryTable();
        return;
    }
    // A configuration from the list replaces the personal file
    $('#configFile').value = '';
    setConfigFileName(null);
    try {
        updateStatus('Chargement de la configuration…', 'info');
        const result = await loadConfigFromUrl(url);
        currentConfig = result.content;
        $('#upload').disabled = !isConnected;
        updateStatus('Configuration chargée : ' + url.split('/').pop(), 'success');

        // Extract and display description
        const description = extractConfigDescription(result.content);
        displayConfigDescription(description);
        setConfigSummaryVisible(false);
    } catch (e) {
        updateStatus(e.message, 'error');
        currentConfig = '';
        $('#upload').disabled = true;
        displayConfigDescription(null);
        await renderConfigSummaryTable();
    }
};

/**
 * Show the chosen personal file name in the custom file picker (null = none)
 */
function setConfigFileName(name) {
    const nameEl = $('#configFileName');
    if (nameEl) nameEl.textContent = name || 'Choisir un fichier (.cfg, .txt…)';
    nameEl?.closest('.file-picker')?.classList.toggle('has-file', !!name);
}

// Personal file
$('#configFile').onchange = async (ev) => {
    const f = ev.target.files?.[0];
    setConfigFileName(f?.name);
    if (!f) {
        currentConfig = '';
        $('#upload').disabled = true;
        displayConfigDescription(null);
        await renderConfigSummaryTable();
        return;
    }
    try {
        updateStatus('Chargement du fichier…', 'info');
        const result = await loadConfigFromFile(f);
        currentConfig = result.content;
        $('#configSelect').value = ''; // deselect conf_files menu
        $('#upload').disabled = !isConnected;
        updateStatus('Fichier chargé : ' + result.filename, 'success');

        // Extract and display description
        const description = extractConfigDescription(result.content);
        displayConfigDescription(description);
        setConfigSummaryVisible(false);
    } catch (e) {
        updateStatus(e.message, 'error');
        currentConfig = '';
        $('#upload').disabled = true;
        setConfigFileName(null);
        displayConfigDescription(null);
        await renderConfigSummaryTable();
    }
};

/* ---------------------- Serial Communication ---------------------- */
$('#connect').onclick = async () => {
    try {
        updateStatus('Connexion…', 'info');

        const result = await connectTransport();

        // Beginner mode specific read loop
        (async function readLoop() {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    // Buffer incoming data and display complete lines only
                    if (value && value.length > 0) {
                        recvBuffer += value;
                        const parts = recvBuffer.split(/\r\n|\n/);
                        recvBuffer = parts.pop(); // remainder
                        for (const part of parts) {
                            if (!part.length) continue;
                            addToTerminal(part, 'received');
                            handleNmeaForMap(part);
                        }
                    }
                }
            } catch (e) {
                updateStatus('Erreur de lecture : ' + e.message, 'error');
            }
        })();

        isConnected = true;
        $('#connect').classList.add('hidden');
        $('#disconnect').classList.remove('hidden');
        $('#disconnect').disabled = false;
        $('#upload').disabled = !currentConfig;
        if (result?.transport === 'ble') {
            setDeviceStatus(result.deviceName || 'Appareil Bluetooth');
            updateStatus(`Connecté en Bluetooth (${result.deviceName || 'appareil'})`, 'success');
        } else {
            setDeviceStatus(`USB · ${result.baudRate} baud`);
            updateStatus(`Connecté en USB à ${result.baudRate} bauds`, 'success');
        }
    } catch (e) {
        // Device chooser closed without selection (Web Bluetooth / Web Serial): not an error
        if (e?.name === 'NotFoundError') {
            updateStatus('Aucun appareil sélectionné.', 'info');
            return;
        }
        updateStatus('Erreur de connexion : ' + (e?.message || e), 'error');
    }
};

$('#disconnect').onclick = async () => {
    try {
        await disconnectTransport();

        isConnected = false;
        $('#connect').classList.remove('hidden');
        $('#disconnect').classList.add('hidden');
        $('#disconnect').disabled = true;
        $('#upload').disabled = true;
        showProgress(false);
        setDeviceStatus(null);
        resetMapPosition();
        updateStatus('Déconnecté', 'info');
    } catch (e) {
        updateStatus('Erreur de déconnexion : ' + (e?.message || e), 'error');
    }
};

/* ---------------------- Upload Commands ---------------------- */
$('#upload').onclick = async () => {
    if (!writer) {
        updateStatus('Non connecté.', 'error');
        return;
    }
    if (!currentConfig) {
        updateStatus('Aucune configuration chargée.', 'error');
        return;
    }
    if (sendingBatch) {
        updateStatus('Envoi déjà en cours, veuillez patienter…', 'info');
        return;
    }

    const lines = currentConfig.split('\n')
        .map(s => s.trim())
        .filter(s => s.length && !s.startsWith('#') && !s.startsWith('//') && !s.startsWith(';'));

    if (!lines.length) {
        updateStatus('Aucune commande valide dans la configuration.', 'error');
        return;
    }

    const delaySec = Math.max(0, parseFloat($('#delay').value || '5') || 5);
    const eol = getEOL();

    sendingBatch = true;
    $('#upload').disabled = true;
    showProgress(true);

    try {
        updateStatus(`Envoi de ${lines.length} commande(s)…`, 'info');
        updateProgress(0, lines.length);

        // Clear terminal and add start message
        clearTerminal();
        addToTerminal(`=== Début de la configuration (${lines.length} commandes) ===`);

        for (let i = 0; i < lines.length; i++) {
            const cmd = lines[i];
            if (cmd.trim().toUpperCase() === 'FRESET' && currentTransport === 'ble') {
                addToTerminal('⏭️ FRESET ignoré en BLE', 'info');
                updateProgress(i + 1, lines.length);
                await sleep(MIN_INTER_COMMAND_DELAY_MS);
                continue;
            }
            let waiterPromise = null;
            // Prepare the correct waiter before writing to avoid race conditions
            if (cmd.trim().toUpperCase() === 'FRESET') {
                // For FRESET, we'll handle a specific sequence after writing the command (not via waiterPromise)
                waiterPromise = null;
            } else {
                // For normal commands, wait for the next non-NMEA received chunk (use delaySec as timeout if > 0)
                const nonNmeaPattern = /^(?!\$[A-Z]{5},).+/;
                waiterPromise = (delaySec > 0)
                    ? waitForReceivedMatching(nonNmeaPattern, delaySec * 1000).catch(() => null)
                    : null;
            }
            await writer.write(cmd + eol);
            if (cmd.trim().toUpperCase() === 'FRESET') {
                addToTerminal('⏳ Attente de la réponse du récepteur après FRESET…', 'info');
            }

            // Display sent command in terminal
            addToTerminal(cmd + eol.replace(/\n/g, '\\n').replace(/\r/g, '\\r'), 'sent');

            updateProgress(i + 1, lines.length);

            // For FRESET: wait for the 3-step reboot sequence: 1) FRESET response OK, 2) 'system is rebooting', 3) '..........'
            // For other commands: wait for the next received chunk (registered before write), and always wait at least MIN_INTER_COMMAND_DELAY_MS
            const sleepPromise = sleep(MIN_INTER_COMMAND_DELAY_MS);
            if (cmd.trim().toUpperCase() === 'FRESET') {
                const patterns = [
                    /FRESET.*response:\s*OK/i,
                    /system\s+is\s+rebooting/i,
                    /^[.]+$/
                ];
                const overallTimeoutMs = Math.max(30000, delaySec * 1000 * 10);
                try {
                    const perMessageTimeoutMs = (delaySec > 0) ? (delaySec * 1000) : 5000;
                    const matched = await waitForSequence(patterns, overallTimeoutMs, perMessageTimeoutMs);
                    if (matched) addToTerminal('✅ Redémarrage du récepteur terminé.', 'info');
                    else addToTerminal('⚠️ Redémarrage du récepteur incomplet, on continue', 'info');
                } catch (e) {
                    addToTerminal('⚠️ Erreur pendant l\'attente du redémarrage : ' + (e?.message || e), 'info');
                }
                // ensure minimal inter-command delay after reboot messages
                await sleepPromise;
                // extra safety pause after FRESET
                addToTerminal('⏸️ Pause 5s après FRESET...', 'info');
                await sleep(5000);
                continue;
            }
            try {
                if (waiterPromise) {
                    await Promise.all([sleepPromise, waiterPromise]);
                } else {
                    await sleepPromise;
                }
            } catch (err) {
                // On timeout (or no reader), continue and log a warning
                addToTerminal(`⚠️ Pas de réponse après ${delaySec} s, on continue`, 'info');
            }
        }

        updateProgress(lines.length, lines.length);
        updateStatus('Configuration envoyée avec succès !', 'success');
        addToTerminal('=== Fin de la configuration ===');

        // Hide progress bar after 3 seconds
        setTimeout(() => showProgress(false), 3000);
    } catch (e) {
        updateStatus('Erreur pendant l\'envoi : ' + (e?.message || e), 'error');
        showProgress(false);
    } finally {
        sendingBatch = false;
        $('#upload').disabled = !currentConfig || !isConnected;
    }
};

$('#save').onclick = async () => {
    try {
        const result = await sendSaveConfig();
        addToTerminal(result.command.replace(/\n/g, '\\n').replace(/\r/g, '\\r'), 'sent');
        updateStatus('Commande SAVECONFIG envoyée', 'success');
    } catch (e) {
        updateStatus(e.message, 'error');
    }
};


// Register service worker for offline / PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
    });
}
