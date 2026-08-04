/**
 * Evidencias SQA — service-worker.js
 * Entry point del Service Worker modularizado.
 */

import { ACTIONS } from './js/background/constants.js';
import { workerState, captureStatus, captureInProgress } from './js/background/state.js';
import { updateCaptureStatus } from './js/background/utils.js';
import { executeCapture, markCaptureCompleted, markCaptureError, waitForCaptureQuota, setHealingCleanup } from './js/background/capture-logic.js';

const TEMP_IMAGE_STORAGE_TTL_MS = 60000;
const CHUNK_TIMEOUT_MS = 30000;
const THUMBNAIL_MAX_WIDTH = 320;
const CAPTURE_IMAGE_FORMAT = 'png';
const VIEWER_API_BASE_URL = 'http://127.0.0.1:3000';

async function swGetSystemInfo() {
    const ua = navigator.userAgent;
    let browser = 'N/A', browserVersion = '';
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    if (chromeMatch && !ua.includes('Edg')) {
        browser = 'Chrome';
        browserVersion = chromeMatch[1];
    } else if (ua.includes('Firefox')) {
        browser = 'Firefox';
        const m = ua.match(/Firefox\/([\d.]+)/);
        if (m) browserVersion = m[1];
    } else if (ua.includes('Edg')) {
        browser = 'Edge';
        const m = ua.match(/Edg\/([\d.]+)/);
        if (m) browserVersion = m[1];
    }
    let os = 'N/A';
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const platVer = uaData.platformVersion || '';
                const buildNum = parseInt(platVer.split('.')[2] || '0', 10);
                os = buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            } else {
                os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
            }
        } catch (e) {
            os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
        }
    } else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    const browserLabel = browserVersion ? `${browser} v${browserVersion}` : browser;
    return { browser: browserLabel, os };
}
const capturePerfByTab = new Map();
const tempImageStorage = new Map();

setHealingCleanup(() => clearHealingInterval());

function log({ stage, status, durationMs, error, metadata }) {
  const entry = { t: Date.now(), s: stage, st: status };
  if (durationMs != null) entry.d = durationMs;
  if (error) entry.err = error;
  if (metadata) entry.m = metadata;
  (error ? console.error : console.log)('[sq]', JSON.stringify(entry));
}

// --- Inicialización ---

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
    validarIconos();
    setupKeepAlive();
});

chrome.runtime.onStartup.addListener(() => {
    validarIconos();
    setupKeepAlive();
});

chrome.runtime.onConnect.addListener((port) => {
    if (port && port.name === 'sqa-keepalive') {
        port.onMessage.addListener(() => {});
    }
});

async function setupKeepAlive() {
    try {
        const docUrl = chrome.runtime.getURL('offscreen.html');
        if (typeof chrome.runtime.getContexts === 'function') {
            const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [docUrl] });
            if (contexts.length > 0) return;
        }
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['WORKERS'],
            justification: 'Keepalive para evitar el cold-start del service worker en capturas y popup.'
        });
    } catch (e) {}
}

setupKeepAlive();

// --- Gestión de Icono y Tema ---

// Cache de iconos para evitar recargar rutas cada vez
const ICON_CACHE = {
  dark: {
    "16": "Media/SQA-16.png",
    "32": "Media/SQA-32.png",
    "48": "Media/SQA-48.png",
    "128": "Media/SQA-128.png"
  },
  light: {
    "16": "Media/SQA1-16.png",
    "32": "Media/SQA1-32.png",
    "48": "Media/SQA1-48.png",
    "128": "Media/SQA1-128.png"
  }
};

let iconCacheValid = false;

/**
 * Valida que los iconos existan y sean accesibles
 * Se ejecuta una vez al iniciar la extensión
 */
async function validarIconos() {
  try {
    const allIcons = [...Object.values(ICON_CACHE.dark), ...Object.values(ICON_CACHE.light)];
    const validationPromises = allIcons.map(async (iconPath) => {
      try {
        const response = await fetch(chrome.runtime.getURL(iconPath), { method: 'HEAD' });
        if (!response.ok) {
          console.warn(`[SQA] Icono no encontrado o inaccesible: ${iconPath}`);
          return false;
        }
        return true;
      } catch (e) {
        console.warn(`[SQA] Error validando icono ${iconPath}:`, e.message);
        return false;
      }
    });
    
    const results = await Promise.all(validationPromises);
    iconCacheValid = results.every(r => r);
    
    if (!iconCacheValid) {
      console.error('[SQA] Algunos iconos no están disponibles. Verifica el directorio Media/');
    } else {
      console.log('[SQA] Validación de iconos completada exitosamente');
    }
  } catch (e) {
    console.error('[SQA] Error durante validación de iconos:', e.message);
    iconCacheValid = false;
  }
}

/**
 * Actualiza el icono de la extensión según el tema
 * @param {string} theme - 'dark' o 'light'
 */
function actualizarIcono(theme) {
  try {
    const isDark = theme === 'dark';
    const iconPaths = isDark ? ICON_CACHE.dark : ICON_CACHE.light;

    chrome.action.setIcon({ path: iconPaths }, () => {
      if (chrome.runtime.lastError) {
        console.error('[SQA] Error aplicando icono:', chrome.runtime.lastError.message);
      } else {
        console.debug(`[SQA] Icono actualizado a tema: ${theme}`);
      }
    });
  } catch (e) {
    console.error('[SQA] Error inesperado en actualizarIcono:', e.message);
  }
}

chrome.tabs.onActivated.addListener((info) => {
    chrome.tabs.get(info.tabId, (tab) => { if (tab) workerState.activeTab = tab; });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (workerState.activeTab && workerState.activeTab.id === tabId) workerState.activeTab = tab;
});

// --- Comandos ---

chrome.commands.onCommand.addListener((command) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        if (command === 'capture-all') executeCapture(tabs[0], "captureAllPageScreenshot");
        else if (command === 'capture-visible') executeCapture(tabs[0], "captureVisibleOnly");
        else if (command === 'capture-area') executeCapture(tabs[0], "captureSelectionEdit");
        else if (command === 'open-viewer') focusDesktopViewer();
    });
});

// --- Mensajes ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || !message.action) return;
    
    const handlers = {
      'themeChanged': () => {
        actualizarIcono(message.theme);
        sendResponse({ ok: true });
      },
        [ACTIONS.captureAll]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureAllPageScreenshot"));
            else if (message.tab) executeCapture(message.tab, "captureAllPageScreenshot");
            sendResponse({ started: true });
        },
        [ACTIONS.captureVisible]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureVisibleOnly"));
            else if (message.tab) executeCapture(message.tab, "captureVisibleOnly");
            sendResponse({ started: true });
        },
        [ACTIONS.captureArea]: () => {
            if (message.tabId) chrome.tabs.get(message.tabId, t => executeCapture(t, "captureSelectionEdit"));
            else if (message.tab) executeCapture(message.tab, "captureSelectionEdit");
            sendResponse({ started: true });
        },
        [ACTIONS.openViewer]: () => {
            focusDesktopViewer();
            sendResponse({ ok: true });
        },
        [ACTIONS.getCaptureStatus]: () => {
            sendResponse({ status: { ...captureStatus } });
        },
        [ACTIONS.resetCaptureStatus]: () => {
            const tid = (sender && sender.tab) ? sender.tab.id : captureStatus.tabId;
            if (tid) captureInProgress.delete(tid);
            clearHealingInterval();
            updateCaptureStatus({ active: false, mode: null, progress: 0, phase: 'idle', message: '', error: '', tabId: null });
            log({ stage: 'capture-flow', status: 'completed', metadata: { action: 'reset', tabId: tid } });
            sendResponse({ ok: true });
        },
        [ACTIONS.setProgress]: () => {
            const tid = sender.tab ? sender.tab.id : captureStatus.tabId;
            touchHeartbeat();
            updateCaptureStatus({
                active: true, progress: message.progress,
                phase: message.progress >= 100 ? 'processing' : 'capturing',
                message: message.progress >= 100 ? 'Procesando...' : 'Capturando...',
                tabId: tid
            });
        },
        "captureVisiblePageScreenshot": () => {
            handleVisibleCaptureRequest(message, sender);
        },
        "requestCaptureScreenshot": () => {
            sendResponse({ imageData: workerState.nowShotImgData, y1: message.y1, y2: message.y2 });
            workerState.nowShotImgData = '';
        },
        "captureVisiblePageScreenshot4Selection": () => {
            handleVisibleCaptureForSelectionRequest(message, sender, false);
        },
        "captureVisiblePageScreenshot4SelectionCopy": () => {
            handleVisibleCaptureForSelectionRequest(message, sender, true);
        },
        "setSelectionCaptureData": () => {
            processFinalImage(message.dataUrl, sender.tab);
            sendResponse({ started: true });
        }
    };

    if (message.action === 'processFinalImageBlob') {
        processFinalImageBlob(message.imageBlob, sender.tab, sendResponse, message.browserName, message.browserVersion, message.os);
        return true;
    }

    if (message.action.startsWith('imgDataChunk')) {
        handleImageChunk(message, sender, sendResponse);
        return true;
    }

    if (handlers[message.action]) {
        log({ stage: 'capture', status: 'start', metadata: { action: message.action } });
        armHealingInterval();
        touchHeartbeat();
        return handlers[message.action]();
    }
  } catch (e) {
    console.error('[SQA] Error manejando mensaje:', message?.action, e.message);
    sendResponse({ error: e.message });
  }
});

function scheduleTempImageCleanup(chunkId) {
    const storage = tempImageStorage.get(chunkId);
    if (!storage) return;
    if (storage.cleanupTimer) clearTimeout(storage.cleanupTimer);
    storage.cleanupTimer = setTimeout(() => {
        tempImageStorage.delete(chunkId);
    }, TEMP_IMAGE_STORAGE_TTL_MS);
}

function clearTempImageCleanup(chunkId) {
    const storage = tempImageStorage.get(chunkId);
    if (storage && storage.cleanupTimer) clearTimeout(storage.cleanupTimer);
}

function destroyChunkStorage(chunkId) {
    clearTempImageCleanup(chunkId);
    tempImageStorage.delete(chunkId);
}

function startCapturePerf(tabId, mode) {
    if (!tabId) return;
    const now = performance.now();
    capturePerfByTab.set(tabId, {
        mode,
        startedAt: now,
        lastMarkAt: now,
        marks: []
    });
}

function markCapturePerf(tabId, stage, extra = {}) {
    const entry = capturePerfByTab.get(tabId);
    if (!entry) return;
    const now = performance.now();
    entry.marks.push({
        stage,
        elapsedMs: Math.round(now - entry.startedAt),
        deltaMs: Math.round(now - entry.lastMarkAt),
        ...extra
    });
    entry.lastMarkAt = now;
}

function finishCapturePerf(tabId) {
    if (!capturePerfByTab.has(tabId)) return;
    capturePerfByTab.delete(tabId);
}

async function focusDesktopViewer() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 800);
        try {
            const resp = await fetch(VIEWER_API_BASE_URL + '/api/show', { signal: controller.signal });
            clearTimeout(timeoutId);
            if (resp.ok) return;
        } catch (e) {
            clearTimeout(timeoutId);
            if (attempt < 4) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
    }

    chrome.tabs.create({ url: 'evidenciassqa://open', active: true }, (tab) => {
        if (!tab || !tab.id) return;

        const startTime = Date.now();
        const checkInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            if (elapsed > 10000) {
                clearInterval(checkInterval);
                return;
            }

            fetch(VIEWER_API_BASE_URL + '/api/show')
            .then(resp => {
                if (resp.ok) {
                    clearInterval(checkInterval);
                    chrome.tabs.remove(tab.id, () => {
                        if (chrome.runtime.lastError) { /* Silenciar error */ }
                    });
                }
            })
            .catch(() => {});
        }, 500);
    });
}

async function sendTabMessage(tabId, message) {
    return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

async function waitForThumbnailHidden(tabId) {
    if (!tabId) return;
    try {
        await sendTabMessage(tabId, { action: 'hideFloatingThumbnail' }).catch(() => null);
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 180));
}

async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('No se pudo leer el blob'));
        reader.readAsDataURL(blob);
    });
}

async function uploadCaptureBinary(blob, tab, browserName, browserVersion, os) {
    if (!(blob instanceof Blob)) {
        throw new Error('uploadCaptureBinary: blob is not a Blob');
    }

    const captureTitle = tab && tab.title ? tab.title : 'Captura SQA';
    const url = tab && tab.url ? tab.url : '';
    const timestamp = new Date().toISOString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const sysInfo = browserName ? { browser: `${browserName} v${browserVersion}`, os: os || 'N/A' } : await swGetSystemInfo();
    try {
        const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-binary', {
            method: 'POST',
            headers: {
                'Content-Type': blob.type || 'image/png',
                'X-SQA-Url': encodeURIComponent(url),
                'X-SQA-Title': encodeURIComponent(captureTitle),
                'X-SQA-Timestamp': timestamp,
                'X-SQA-Browser': encodeURIComponent(sysInfo.browser),
                'X-SQA-OS': encodeURIComponent(sysInfo.os)
            },
            body: blob,
            signal: controller.signal
        });
        let autoCopyOnCapture = null;
        try {
            const apiJson = await resp.clone().json();
            autoCopyOnCapture = apiJson && apiJson.autoCopyOnCapture;
        } catch (e) {}
        resp._autoCopyOnCapture = autoCopyOnCapture;
        return resp;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function getBlobFromDataUrl(dataUrl) {
    try {
        const commaIdx = dataUrl.indexOf(',');
        const mimeMatch = dataUrl.substring(0, commaIdx).match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const raw = atob(dataUrl.substring(commaIdx + 1));
        const len = raw.length;
        const u8arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8arr[i] = raw.charCodeAt(i);
        return new Blob([u8arr], { type: mime });
    } catch (e) {
        try {
            const response = await fetch(dataUrl);
            return await response.blob();
        } catch (e2) {
            return null;
        }
    }
}

async function buildPreviewThumbnail(predecodedBlob, dataUrl) {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        return dataUrl || await blobToDataUrl(predecodedBlob);
    }

    const bitmap = await createImageBitmap(predecodedBlob);

    try {
        const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / bitmap.width);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.drawImage(bitmap, 0, 0, width, height);
        const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
        return await blobToDataUrl(thumbBlob);
    } finally {
        bitmap.close();
    }
}

// --- Lógica de Captura Visible Avanzada ---

function isBlankImageData(dataUrl) {
    try {
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx === -1) return false;
        const raw = atob(dataUrl.substring(commaIdx + 1));
        if (raw.length < 100) return true;
        const sample = raw.charCodeAt(0);
        for (let i = 1; i < Math.min(raw.length, 200); i++) {
            if (raw.charCodeAt(i) !== sample) return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function handleVisibleCaptureRequest(message, sender) {
    const targetTabId = sender.tab ? sender.tab.id : (workerState.activeTab ? workerState.activeTab.id : null);
    if (!targetTabId) return;

    try {
        startCapturePerf(targetTabId, 'visible-capture');
        markCapturePerf(targetTabId, 'capture-format-selected', { format: CAPTURE_IMAGE_FORMAT });
        const checkTab = await new Promise(resolve => {
            chrome.tabs.get(targetTabId, (tab) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(tab);
            });
        });
        if (!checkTab) {
            finishCapturePerf(targetTabId, 'tab-not-found');
            return;
        }

        await waitForThumbnailHidden(targetTabId);
        markCapturePerf(targetTabId, 'thumbnail-hidden');

        const windowId = checkTab.windowId;

        let attempt = 0;
        const MAX = 10;
        
        const tryCapture = async () => {
            attempt++;
            await waitForCaptureQuota();
            chrome.tabs.captureVisibleTab(windowId, { format: CAPTURE_IMAGE_FORMAT }, (data) => {
                if (chrome.runtime.lastError) {
                    if (attempt < MAX) setTimeout(tryCapture, 150);
                    else {
                        finishCapturePerf(targetTabId, 'capture-error', { message: chrome.runtime.lastError.message });
                        markCaptureError(chrome.runtime.lastError.message, targetTabId);
                    }
                    return;
                }
                
                if (isBlankImageData(data)) {
                    if (attempt < MAX) {
                        const backoff = 150 + attempt * 100;
                        console.warn(`[SQA] Captura en blanco detectada (intento ${attempt}), reintentando en ${backoff}ms...`);
                        setTimeout(tryCapture, backoff);
                    } else {
                        finishCapturePerf(targetTabId, 'blank-capture', { attempt });
                    }
                    return;
                }
                
                workerState.nowShotImgData = data;
                markCapturePerf(targetTabId, 'visible-captured', { attempt });
                chrome.tabs.sendMessage(targetTabId, {
                    action: 'getNowShotImgData',
                    y1: message.y1, y2: message.y2,
                    nextPageData: message.nextPageData
                }, () => {
                    if (chrome.runtime.lastError) {
                        finishCapturePerf(targetTabId, 'content-bridge-error', { message: chrome.runtime.lastError.message });
                        markCaptureError(chrome.runtime.lastError.message, targetTabId);
                    } else {
                        markCapturePerf(targetTabId, 'content-bridge-dispatched');
                    }
                });
            });
        };
        tryCapture();
    } catch (e) {
        finishCapturePerf(targetTabId, 'exception', { message: e.message });
        markCaptureError(e.message, targetTabId);
    }
}

async function handleVisibleCaptureForSelectionRequest(message, sender, forCopy = false) {
    const targetTabId = sender.tab ? sender.tab.id : (workerState.activeTab ? workerState.activeTab.id : null);
    if (!targetTabId) return;

    try {
        const checkTab = await new Promise(resolve => {
            chrome.tabs.get(targetTabId, (tab) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(tab);
            });
        });
        if (!checkTab) return;

        await waitForThumbnailHidden(targetTabId);

        const windowId = checkTab.windowId;
        chrome.tabs.captureVisibleTab(windowId, { format: CAPTURE_IMAGE_FORMAT }, (data) => {
            if (chrome.runtime.lastError) {
                console.error("Selection capture error:", chrome.runtime.lastError.message);
                return;
            }
            
            chrome.tabs.sendMessage(targetTabId, {
                action: 'croppedImageResult',
                dataUrl: data,
                forCopy: forCopy ? 1 : 0
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error("Error sending croppedImageResult back:", chrome.runtime.lastError.message);
                }
            });
        });
    } catch (e) {
        console.error("Exception in handleVisibleCaptureForSelectionRequest:", e);
    }
}

// --- Manejo de Chunks de Imagen Optimizado ---

function allChunksPresent(storage) {
    for (let i = 0; i < storage.chunks.length; i++) {
        if (storage.chunks[i] === undefined || storage.chunks[i] === null) return false;
    }
    return true;
}

function handleImageChunk(message, sender, sendResponse) {
    const chunkId = message.action;

    if (!message || typeof message.dataIndex !== 'number' || typeof message.dataLength !== 'number') {
        sendResponse({ rtn: 0, error: 'invalid chunk message' });
        return;
    }

    if (message.dataIndex === 0 && !tempImageStorage.has(chunkId)) {
        tempImageStorage.set(chunkId, {
            chunks: new Array(message.dataLength),
            receivedCount: 0,
            cleanupTimer: null,
            captureTimeout: setTimeout(() => {
                destroyChunkStorage(chunkId);
            }, CHUNK_TIMEOUT_MS)
        });
    }

    const storage = tempImageStorage.get(chunkId);
    if (!storage) {
        sendResponse({ rtn: 1, index: message.dataIndex });
        return;
    }

    if (storage.chunks[message.dataIndex] === undefined) {
        storage.chunks[message.dataIndex] = message.dataItem;
        storage.receivedCount++;
    }
    scheduleTempImageCleanup(chunkId);

    if (storage.receivedCount === message.dataLength && allChunksPresent(storage)) {
        clearTimeout(storage.captureTimeout);
        if (sender.tab && sender.tab.id) {
            markCapturePerf(sender.tab.id, 'all-chunks-received', { totalChunks: message.dataLength });
        }
        log({ stage: 'capture', status: 'success', metadata: { totalChunks: message.dataLength } });
        touchHeartbeat();
        const fullData = storage.chunks.join('');
        destroyChunkStorage(chunkId);
        processFinalImage(fullData, sender.tab);
    }
    sendResponse({ rtn: 1, index: message.dataIndex });
}

async function processFinalImage(imageData, tab) {
    if (!imageData || typeof imageData !== 'string') {
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        return;
    }
    const blob = await getBlobFromDataUrl(imageData);
    if (!blob) {
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        return;
    }
    const dataUrl = imageData;
    await _finalizeCapture(blob, dataUrl, tab);
}

async function processFinalImageBlob(imageBlobOrData, tab, sendResponse, browserName, browserVersion, os) {
    let imageBlob = imageBlobOrData;
    let imageDataUrl = '';

    if (typeof imageBlobOrData === 'string' && imageBlobOrData.startsWith('data:')) {
        imageDataUrl = imageBlobOrData;
        imageBlob = await getBlobFromDataUrl(imageBlobOrData);
    }

    if (!(imageBlob instanceof Blob) && imageDataUrl) {
        imageBlob = await getBlobFromDataUrl(imageDataUrl);
    }

    if (!(imageBlob instanceof Blob)) {
        if (tab && tab.id) finishCapturePerf(tab.id, 'conversion-failed');
        clearHealingInterval();
        markCaptureCompleted();
        if (sendResponse) sendResponse({ ok: false });
        return;
    }

    if (!imageDataUrl) imageDataUrl = await blobToDataUrl(imageBlob);
    await _finalizeCapture(imageBlob, imageDataUrl, tab, browserName, browserVersion, os);
    if (sendResponse) { try { sendResponse({ ok: true }); } catch (e) {} }
}

async function _finalizeCapture(imageBlob, imageDataUrl, tab, browserName, browserVersion, os) {
    const tabId = tab && tab.id ? tab.id : null;
    const startMs = performance.now();
    let uploadOk = false;
    let uploadResp = null;

    try {
        if (tabId) markCapturePerf(tabId, 'binary-upload-start');
        const resp = await uploadCaptureBinary(imageBlob, tab, browserName, browserVersion, os);
        uploadResp = resp;
        if (!resp.ok) {
            if (tabId) markCapturePerf(tabId, 'binary-upload-rejected', { status: resp.status });
            throw new Error('Visor rechazo captura binaria: ' + resp.status);
        }
        uploadOk = true;
        if (tabId) markCapturePerf(tabId, 'binary-upload-complete', { status: resp.status });
    } catch (error) {
        if (tabId) markCapturePerf(tabId, 'binary-upload-fallback', { message: error.message });
        if (tab && imageDataUrl) {
            const url = tab.url || '';
            try {
                const fbBrowser = browserName && browserVersion ? `${browserName} v${browserVersion}` : (await swGetSystemInfo()).browser;
                const fallbackResp = await fetch(VIEWER_API_BASE_URL + '/api/capture', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        dataUrl: imageDataUrl,
                        url: url,
                        title: tab.title || 'Captura SQA',
                        timestamp: new Date().toISOString(),
                        browser: fbBrowser,
                        os: os || (await swGetSystemInfo()).os
                    })
                });
                if (fallbackResp.ok) {
                    uploadOk = true;
                } else {
                    throw new Error('Fallo envío JSON fallback: ' + fallbackResp.status);
                }
            } catch (fallbackError) {
                console.warn('[SQA Sync] Ambos envíos inmediatos fallaron (app cerrada). Guardando en cola local:', fallbackError.message);
                await savePendingCapture(imageBlob, imageDataUrl, tab);
            }
        }
    }

    log({
        stage: 'upload',
        status: uploadOk ? 'success' : 'fail',
        durationMs: Math.round(performance.now() - startMs),
        error: uploadOk ? undefined : 'upload failed'
    });

    const autoCopyOnCapture = (typeof uploadResp !== 'undefined' && uploadResp && uploadResp._autoCopyOnCapture) || null;
    if (tab && tab.id && autoCopyOnCapture !== true) {
        const [thumbResult] = await Promise.allSettled([
            buildPreviewThumbnail(imageBlob, imageDataUrl).catch(() => null)
        ]);
        const previewData = thumbResult.value || '';
        if (previewData) markCapturePerf(tab.id, 'preview-generated');
        await Promise.allSettled([
            sendTabMessage(tab.id, {
                action: 'showFloatingThumbnail',
                imageData: previewData,
                fullImageData: imageDataUrl || previewData
            }).catch(() => {})
        ]);
    }
    if (tab && tab.id) captureInProgress.delete(tab.id);
    if (tabId) {
        markCapturePerf(tabId, 'completed', { totalMs: Math.round(performance.now() - startMs) });
        finishCapturePerf(tabId);
    }
    clearHealingInterval();
    markCaptureCompleted();
    imageBlob = null; imageDataUrl = null;
}

// ── Self-healing: watchdog automático de estado de captura ──

const WATCHDOG_INTERVAL_MS = 3000;
const MAX_CAPTURE_TIME_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 8000;

let captureStartTime = 0;
let lastCaptureActivity = 0;
let healingInterval = null;

function touchHeartbeat() {
    lastCaptureActivity = Date.now();
}

function isCaptureHealthy() {
    if (!captureStatus.active) return true;
    if (tempImageStorage.size > 0) return true;

    const now = Date.now();
    const elapsed = now - captureStartTime;

    if (elapsed < MAX_CAPTURE_TIME_MS) return true;
    if (now - lastCaptureActivity < HEARTBEAT_TIMEOUT_MS) return true;

    return false;
}

function triggerSelfHealing(reason) {
    const elapsedMs = captureStartTime ? Date.now() - captureStartTime : 0;
    log({ stage: 'self-healing', status: 'triggered', reason, durationMs: elapsedMs });

    captureInProgress.activeTabs.clear();
    tempImageStorage.clear();
    capturePerfByTab.clear();
    captureStartTime = 0;
    lastCaptureActivity = 0;
    updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    clearHealingInterval();
}

function armHealingInterval() {
    captureStartTime = Date.now();
    touchHeartbeat();
    clearHealingInterval();
    healingInterval = setInterval(() => {
        if (!isCaptureHealthy()) {
            triggerSelfHealing('stuck-detected');
        }
    }, WATCHDOG_INTERVAL_MS);
}

function clearHealingInterval() {
    if (healingInterval !== null) {
        clearInterval(healingInterval);
        healingInterval = null;
    }
    captureStartTime = 0;
    lastCaptureActivity = 0;
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (captureInProgress.has(tabId)) {
        clearHealingInterval();
        captureInProgress.delete(tabId);
        capturePerfByTab.delete(tabId);
        updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    }
});

self.addEventListener('message', (event) => {
    if (event.data === 'cancel-all-captures') {
        clearHealingInterval();
        captureInProgress.activeTabs.clear();
        capturePerfByTab.clear();
        updateCaptureStatus({ active: false, phase: 'idle', tabId: null });
    }
});

// =========================================================================
// SISTEMA DE SINCRONIZACIÓN EN SEGUNDO PLANO - PERSISTENCIA OFFLINE
// =========================================================================

async function savePendingCapture(blob, dataUrl, tab) {
    try {
        const url = tab && tab.url ? tab.url : '';
        const title = tab && tab.title ? tab.title : 'Captura SQA';
        const timestamp = new Date().toISOString();
        
        const base64Data = dataUrl || await blobToDataUrl(blob);
        
        const result = await chrome.storage.local.get({ pendingCaptures: [] });
        const pending = result.pendingCaptures || [];
        
        pending.push({
            id: Date.now() + '-' + Math.round(Math.random() * 1000000),
            dataUrl: base64Data,
            url: url,
            title: title,
            timestamp: timestamp
        });
        
        await chrome.storage.local.set({ pendingCaptures: pending });
        console.log(`[SQA Sync] Captura offline persistida para sincronización. Total pendientes: ${pending.length}`);
        
        scheduleAutoSync(4000);
    } catch (err) {
        console.error('[SQA Sync] Error al guardar captura pendiente offline:', err);
    }
}

let isSyncing = false;
async function trySyncPendingCaptures() {
    if (isSyncing) return;
    isSyncing = true;

    try {
        const result = await chrome.storage.local.get({ pendingCaptures: [] });
        const pending = result.pendingCaptures || [];

        if (pending.length === 0) {
            isSyncing = false;
            return;
        }

        console.log(`[SQA Sync] Procesando cola offline: ${pending.length} capturas pendientes.`);

        let stillPending = pending;
        if (pending.length >= 2) {
            stillPending = await tryBatchSync(pending);
        }

        if (stillPending.length > 0) {
            stillPending = await tryIndividualSync(stillPending);
        }

        await chrome.storage.local.set({ pendingCaptures: stillPending });
        console.log(`[SQA Sync] Cola guardada con restantes: ${stillPending.length}`);

        if (stillPending.length > 0) {
            scheduleAutoSync(30000);
        }
    } catch (globalErr) {
        console.error('[SQA Sync] Error en bucle principal offline:', globalErr);
    } finally {
        isSyncing = false;
    }
}

async function tryBatchSync(pending) {
    try {
        const caps = pending.map(cap => ({
            dataUrl: cap.dataUrl,
            url: cap.url || '',
            title: cap.title || 'Captura SQA',
            timestamp: cap.timestamp || new Date().toISOString()
        }));

        const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ captures: caps })
        });

        if (!resp.ok) {
            console.warn('[SQA Sync] Batch endpoint no disponible, fallback a individual');
            return pending;
        }

        const data = await resp.json();
        if (data.success && Array.isArray(data.results)) {
            const failed = [];
            for (let i = 0; i < data.results.length; i++) {
                if (!data.results[i].success) {
                    failed.push(pending[i]);
                }
            }
            const succeeded = pending.length - failed.length;
            console.log(`[SQA Sync] Batch completado: ${succeeded}/${pending.length} exitosas`);
            return failed;
        }
    } catch (e) {
        console.warn('[SQA Sync] Error en batch sync, fallback a individual:', e.message);
    }
    return pending;
}

async function tryIndividualSync(pending) {
    const stillPending = [];
    for (const cap of pending) {
        let success = false;
        const sysSync = await swGetSystemInfo();
        try {
            const blob = await getBlobFromDataUrl(cap.dataUrl);
            if (blob) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                try {
                    const resp = await fetch(VIEWER_API_BASE_URL + '/api/capture-binary', {
                        method: 'POST',
                        headers: {
                            'Content-Type': blob.type || 'image/png',
                            'X-SQA-Url': encodeURIComponent(cap.url),
                            'X-SQA-Title': encodeURIComponent(cap.title),
                            'X-SQA-Timestamp': cap.timestamp,
                            'X-SQA-Browser': encodeURIComponent(sysSync.browser),
                            'X-SQA-OS': encodeURIComponent(sysSync.os)
                        },
                        body: blob,
                        signal: controller.signal
                    });
                    if (resp.ok) success = true;
                } catch (e) {
                    console.warn('[SQA Sync] Fallo envío binario, probando JSON', e.message);
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            if (!success) {
                const fallbackResp = await fetch(VIEWER_API_BASE_URL + '/api/capture', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        dataUrl: cap.dataUrl,
                        url: cap.url,
                        title: cap.title,
                        timestamp: cap.timestamp,
                        browser: sysSync.browser,
                        os: sysSync.os
                    })
                });
                if (fallbackResp.ok) success = true;
            }
        } catch (err) {
            console.error(`[SQA Sync] Error enviando captura offline pid: ${cap.id}`, err);
        }

        if (success) {
            console.log(`[SQA Sync] Sincronizada captura offline con éxito: ${cap.id}`);
        } else {
            stillPending.push(cap);
        }
    }
    return stillPending;
}

let syncTimeoutId = null;
function scheduleAutoSync(delayMs = 15000) {
    if (syncTimeoutId) clearTimeout(syncTimeoutId);
    syncTimeoutId = setTimeout(() => {
        trySyncPendingCaptures();
    }, delayMs);
}

try {
    chrome.runtime.onStartup.addListener(() => {
        scheduleAutoSync(5000);
    });
} catch (e) {}

try {
    chrome.tabs.onActivated.addListener(() => {
        scheduleAutoSync(10000);
    });
} catch (e) {}

scheduleAutoSync(3000);