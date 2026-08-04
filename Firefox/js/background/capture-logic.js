/**
 * Evidencias SQA — background/capture-logic.js
 * Lógica de captura y procesamiento de fragmentos.
 */

import { workerState, captureStatus, captureInProgress } from './state.js';
import { updateCaptureStatus } from './utils.js';
import { CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS } from './constants.js';

// ============================================================================
// ERROR BUFFER CIRCULAR (para diagnóstico post-mortem)
// ============================================================================
const ERROR_BUFFER_SIZE = 50;
const errorBuffer = [];
let errorBufferIndex = 0;

function logErrorToBuffer(error, context) {
    const entry = {
        timestamp: Date.now(),
        context,
        message: error?.message || String(error),
        stack: error?.stack || null
    };
    errorBuffer[errorBufferIndex] = entry;
    errorBufferIndex = (errorBufferIndex + 1) % ERROR_BUFFER_SIZE;
}

export function getErrorBuffer() {
    return [...errorBuffer];
}

// ============================================================================
// CLASIFICACIÓN DE ERRORES
// ============================================================================
const CRITICAL_ERRORS = [
    'tab was closed',
    'No tab with id',
    'cannot access contents',
    'extensions gallery cannot be scripted'
];

const EXPECTED_ERRORS = [
    'frame with id 0 is showing error page',
    'showing error page',
    'Failed to fetch'
];

function classifyError(error) {
    const message = (error?.message || String(error)).toLowerCase();
    if (CRITICAL_ERRORS.some(err => message.includes(err))) {
        return 'critical';
    }
    if (EXPECTED_ERRORS.some(err => message.includes(err))) {
        return 'expected';
    }
    return 'unknown';
}

// ============================================================================
// TIMEOUTS CONTROLADOS
// ============================================================================
const DEFAULT_TIMEOUT_MS = 8000;
const DEBUGGER_TIMEOUT_MS = 12000;

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, context = 'operation') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            logErrorToBuffer(new Error(`Timeout after ${ms}ms in ${context}`), context);
            reject(new Error(`Timeout: ${context}`));
        }, ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timeoutId)),
        timeoutPromise
    ]);
}

// ============================================================================
// CLEANUP DE EVENT LISTENERS
// ============================================================================
let _healingCleanup = null;
export function setHealingCleanup(fn) { _healingCleanup = fn; }

function cleanupListeners(tabId) {
    try {
        if (_healingCleanup) _healingCleanup();
        chrome.debugger.detach({ tabId }).catch(() => {});
    } catch (e) {
        console.warn('[cleanup] Error detaching debugger:', e.message);
    }
}

export async function executeCapture(tab, actionName) {
    const tabUrl = tab.url || '';
    if (
        !tabUrl ||
        tabUrl.startsWith("chrome://") ||
        tabUrl.startsWith("chrome-error://") ||
        tabUrl.startsWith("edge://") ||
        tabUrl.startsWith("about:") ||
        tabUrl.startsWith("chrome-extension://") ||
        tabUrl.includes("chrome.google.com/webstore") ||
        tabUrl.includes("chromewebstore.google.com")
    ) {
        markCaptureError("Captura no permitida", tab.id);
        return;
    }

    if (captureInProgress.has(tab.id)) {
        updateCaptureStatus({ active: true, message: 'Ya hay una captura en curso.', tabId: tab.id });
        return;
    }

    captureInProgress.add(tab.id);
    workerState.activeTab = tab;

    updateCaptureStatus({
        active: true,
        mode: actionName === "captureAllPageScreenshot" ? 'full' : (actionName === "captureSelectionEdit" ? 'area' : 'visible'),
        progress: actionName === "captureAllPageScreenshot" ? 5 : 10,
        phase: 'starting',
        message: actionName === "captureSelectionEdit" ? 'Iniciando selección de área...' : 'Preparando captura...',
        error: '',
        tabId: tab.id
    });

    // Fast-path: chrome.debugger para Chrome/Edge (más rápido, sin stitching)
    // Sólo full-page y visible; selection mantiene content script (overlay + crop)
    if (actionName === "captureAllPageScreenshot" || actionName === "captureVisibleOnly") {
        try {
            // Optimización crítica: import() dinámico está prohibido en Service Workers
            // Detectar contexto inmediatamente para evitar error esperado
            const isServiceWorker = typeof self !== 'undefined' && 
                                    self.constructor.name === 'ServiceWorkerGlobalScope';
            
            if (isServiceWorker) {
                console.debug('[capture-logic] Service Worker detectado - skip debugger fast-path (optimización)');
                throw new Error('Service Worker context - import() no disponible');
            }
            
            const CaptureEngine = await withTimeout(
                import('./CaptureEngine.js'),
                DEBUGGER_TIMEOUT_MS,
                'import CaptureEngine'
            );
            if (CaptureEngine.isAvailable && await CaptureEngine.isAvailable()) {
                await withTimeout(CaptureEngine.init(), DEBUGGER_TIMEOUT_MS, 'CaptureEngine.init');
                const browserInfo = await _getBrowserInfo();
                browserInfo.url = tab.url || '';
                let dataUrl;

                if (actionName === "captureAllPageScreenshot") {
                    dataUrl = await withTimeout(
                        CaptureEngine.captureFullPage(tab.id, browserInfo),
                        DEBUGGER_TIMEOUT_MS,
                        'captureFullPage'
                    );
                } else {
                    dataUrl = await withTimeout(
                        CaptureEngine.captureVisible(tab.id, browserInfo),
                        DEBUGGER_TIMEOUT_MS,
                        'captureVisible'
                    );
                }

                // Validación de dimensiones antes de procesar
                if (dataUrl && dataUrl.dataUrl) {
                    try {
                        const testBlob = await fetch(dataUrl.dataUrl).then(r => r.blob());
                        const bitmap = await createImageBitmap(testBlob);
                        if (bitmap.width < 100 || bitmap.height < 100) {
                            bitmap.close();
                            throw new Error('Captura inválida: dimensiones demasiado pequeñas');
                        }
                        bitmap.close();
                    } catch (dimErr) {
                        console.warn('[capture-logic] Validación de dimensiones falló:', dimErr.message);
                        logErrorToBuffer(dimErr, 'dimension-validation');
                        throw dimErr;
                    }

                    const blob = dataUrl.blob || await (await fetch(dataUrl.dataUrl)).blob();
                    const osLabel = browserInfo?.os || (await _detectOS());
                    const browserLabel = browserInfo?.name && browserInfo?.version
                        ? `${browserInfo.name} v${browserInfo.version}` : (await _detectBrowser());
                    const apiResp = await fetch('http://127.0.0.1:3000/api/capture-binary', {
                        method: 'POST',
                        headers: {
                            'Content-Type': blob.type || 'image/png',
                            'X-SQA-Url': encodeURIComponent(tab.url || ''),
                            'X-SQA-Timestamp': new Date().toISOString(),
                            'X-SQA-Browser': encodeURIComponent(browserLabel),
                            'X-SQA-OS': encodeURIComponent(osLabel),
                            'X-SQA-Has-Header': dataUrl.hasHeaderAlready === false ? 'false' : 'true',
                        },
                        body: blob,
                    });
                    if (apiResp.ok) {
                        // autoCopyOnCapture ON → el desktop copia solo y notifica nativamente,
                        // así que la extensión omite la miniatura flotante.
                        let autoCopyOnCapture = null;
                        try {
                            const apiJson = await apiResp.clone().json();
                            autoCopyOnCapture = apiJson && apiJson.autoCopyOnCapture;
                        } catch (e) { /* body no es JSON o no accesible */ }
                        if (autoCopyOnCapture !== true) {
                            await _sendThumbnail(tab, blob, dataUrl.dataUrl);
                        }
                        captureInProgress.delete(tab.id);
                        markCaptureCompleted('Captura completada.');
                    } else {
                        captureInProgress.delete(tab.id);
                        markCaptureError(`Error al enviar captura (HTTP ${apiResp.status})`, tab.id);
                    }
                    return;
                }
            }
        } catch (err) {
            const errorClass = classifyError(err);
            
            // Optimización: errores de Service Worker son esperados, no loguear como warning
            const isServiceWorkerError = err.message && err.message.includes('Service Worker');
            
            if (errorClass === 'expected' || isServiceWorkerError) {
                console.debug('[capture-logic] Error esperado en fast-path:', err.message);
            } else {
                console.warn('[capture-logic] Fast-path debugger falló, usando content script:', err.message);
                logErrorToBuffer(err, 'debugger-fallback');
            }
            // Telemetría de fallback: detectar cuándo el fullpage no usa debugger
            try {
                const prev = (globalThis.__sqaFallbackCount || 0) + 1;
                globalThis.__sqaFallbackCount = prev;
                console.debug(`[capture-logic] Fallback a content script #${prev} — modo=${actionName}, motivo=${err.message}`);
            } catch (te) { /* telemetría no crítica */ }
        }
    }

    // Fallback: content script (para Firefox o si debugger falla)
    try {
        const isLoaded = await withTimeout(checkContentScript(tab.id), 3000, 'checkContentScript');
        if (!isLoaded) {
            await withTimeout(
                chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }),
                5000,
                'executeScript content.js'
            );
            await new Promise(r => setTimeout(r, 150));
        }

        const sent = await retrySendMessage(tab.id, { action: actionName });
        if (!sent) {
            captureInProgress.delete(tab.id);
            markCaptureError("No se pudo iniciar la captura.", tab.id);
        }
    } catch (err) {
        const errorClass = classifyError(err);
        logErrorToBuffer(err, 'content-script-fallback');
        if (err.message && err.message.includes('cannot be scripted')) {
            console.warn('[capture-logic] Content script blocked, fallback a captura directa');
            captureDirectCapture(tab);
        } else {
            captureInProgress.delete(tab.id);
            if (errorClass === 'critical') {
                console.error('[capture-logic] Error crítico en content script:', err.message);
            } else {
                console.warn('[capture-logic] Error en content script:', err.message);
            }
            markCaptureError(err.message, tab.id);
        }
    }
}

const THUMB_MAX_W = 320;

async function _sendThumbnail(tab, blob, dataUrl) {
    if (!tab || !tab.id) return;
    try {
        let thumbDataUrl = dataUrl;
        if (typeof OffscreenCanvas !== 'undefined') {
            // Generar la miniatura desde el dataUrl minimal (con header) para
            // que la vista previa ya muestre el encabezado.
            const sourceBlob = dataUrl ? await (await fetch(dataUrl)).blob() : blob;
            const bitmap = await createImageBitmap(sourceBlob);
            const scale = Math.min(1, THUMB_MAX_W / bitmap.width);
            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.drawImage(bitmap, 0, 0, w, h);
            const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
            thumbDataUrl = await new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r(fr.result); fr.readAsDataURL(thumbBlob); });
            bitmap.close();
        }
        await chrome.tabs.sendMessage(tab.id, {
            action: 'showFloatingThumbnail',
            imageData: thumbDataUrl,
            fullImageData: dataUrl || thumbDataUrl
        }).catch(() => {});
    } catch {}
}

async function _detectOS() {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const buildNum = parseInt((uaData.platformVersion || '').split('.')[2] || '0', 10);
                return buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            }
        } catch {}
        return /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows';
    }
    if (/Mac/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'N/A';
}

async function _detectBrowser() {
    const ua = navigator.userAgent;
    if (ua.includes('Edg')) return 'Edge v' + (ua.match(/Edg\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Chrome')) return 'Chrome v' + (ua.match(/Chrome\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Firefox')) return 'Firefox v' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '');
    return 'N/A';
}

async function _getBrowserInfo() {
    const ua = navigator.userAgent;
    let name = 'N/A', version = '', os = 'N/A';
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    if (chromeMatch && !ua.includes('Edg')) {
        name = 'Chrome'; version = chromeMatch[1];
    } else if (ua.includes('Edg')) {
        name = 'Edge'; const m = ua.match(/Edg\/([\d.]+)/); if (m) version = m[1];
    } else if (ua.includes('Firefox')) {
        name = 'Firefox'; const m = ua.match(/Firefox\/([\d.]+)/); if (m) version = m[1];
    }
    if (/Windows/.test(ua)) {
        try {
            if (navigator.userAgentData?.getHighEntropyValues) {
                const uaData = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
                const buildNum = parseInt((uaData.platformVersion || '').split('.')[2] || '0', 10);
                os = buildNum >= 22000 ? 'Windows 11' : 'Windows 10';
            } else { os = /Windows NT 10/.test(ua) ? 'Windows 10' : 'Windows'; }
        } catch { os = 'Windows'; }
    } else if (/Mac/.test(ua)) { os = 'macOS'; }
    else if (/Linux/.test(ua)) { os = 'Linux'; }
    return { name, version, os };
}

async function captureDirectCapture(tab) {
    const tabId = tab?.id;
    try {
        const dataUrl = await withTimeout(
            new Promise((resolve, reject) => {
                chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (data) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(data);
                });
            }),
            8000,
            'captureVisibleTab'
        );
        if (dataUrl) {
            // Validación de dimensiones antes de enviar
            try {
                const testBlob = await fetch(dataUrl).then(r => r.blob());
                const bitmap = await createImageBitmap(testBlob);
                if (bitmap.width < 100 || bitmap.height < 100) {
                    bitmap.close();
                    throw new Error('Captura directa inválida: dimensiones demasiado pequeñas');
                }
                bitmap.close();
            } catch (dimErr) {
                console.warn('[capture-logic] Validación de dimensiones en captura directa falló:', dimErr.message);
                logErrorToBuffer(dimErr, 'direct-capture-validation');
                throw dimErr;
            }

            const blob = await (await fetch(dataUrl)).blob();
            const captureTitle = tab && tab.title ? tab.title : 'Captura SQA';
            const url = tab && tab.url ? tab.url : '';
            const timestamp = new Date().toISOString();
            const resp = await fetch('http://127.0.0.1:3000/api/capture-binary', {
                method: 'POST',
                headers: {
                    'Content-Type': blob.type || 'image/png',
                    'X-SQA-Url': encodeURIComponent(url),
                    'X-SQA-Title': encodeURIComponent(captureTitle),
                    'X-SQA-Timestamp': timestamp,
                },
                body: blob,
            });
            if (resp.ok) {
                markCaptureCompleted('Captura directa completada.');
            } else {
                markCaptureError(`Visor rechazó la captura (HTTP ${resp.status})`, tabId);
            }
        } else {
            markCaptureError('No se pudo capturar la página.', tabId);
        }
    } catch (e) {
        logErrorToBuffer(e, 'direct-capture');
        const errorClass = classifyError(e);
        if (e.message && e.message.includes('Failed to fetch')) {
            markCaptureError('App de escritorio no disponible. Inicia Evidencias SQA Desktop.', tabId);
        } else {
            if (errorClass === 'critical') {
                console.error('[capture-logic] Error crítico en captura directa:', e.message);
            } else {
                console.warn('[capture-logic] Error en captura directa:', e.message);
            }
            markCaptureError(e.message, tabId);
        }
    } finally {
        captureInProgress.delete(tabId);
        cleanupListeners(tabId);
    }
}

async function checkContentScript(tabId) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            logErrorToBuffer(new Error('Timeout en checkContentLoaded'), 'checkContentScript-timeout');
            resolve(false);
        }, 2500);
        chrome.tabs.sendMessage(tabId, { action: "checkContentLoaded" }, (res) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError || !res || !res.loaded) resolve(false);
            else resolve(true);
        });
    });
}

async function retrySendMessage(tabId, msg, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        const success = await new Promise(resolve => {
            const timeoutId = setTimeout(() => {
                logErrorToBuffer(new Error(`Timeout en intento ${i} de sendMessage`), 'sendMessage-timeout');
                resolve(false);
            }, 2000);
            chrome.tabs.sendMessage(tabId, msg, () => {
                clearTimeout(timeoutId);
                if (chrome.runtime.lastError) resolve(false);
                else resolve(true);
            });
        });
        if (success) return true;
        await new Promise(r => setTimeout(r, 150 * i));
    }
    logErrorToBuffer(new Error(`Fallo después de ${retries} intentos`), 'sendMessage-all-retries-failed');
    return false;
}

export function markCaptureCompleted(message = 'Captura completada.') {
    if (workerState.clearCompletedStatusTimer) clearTimeout(workerState.clearCompletedStatusTimer);
    if (captureStatus.tabId) captureInProgress.delete(captureStatus.tabId);

    updateCaptureStatus({ active: false, progress: 100, phase: 'completed', message, error: '' });
    workerState.clearCompletedStatusTimer = setTimeout(() => {
        updateCaptureStatus({ active: false, mode: null, progress: 0, phase: 'idle', message: '', error: '', tabId: null });
    }, 4000);
}

export function markCaptureError(message, tabId = captureStatus.tabId) {
    try {
        if (workerState.clearCompletedStatusTimer) clearTimeout(workerState.clearCompletedStatusTimer);
        if (tabId) {
            captureInProgress.delete(tabId);
            cleanupListeners(tabId);
        }
        updateCaptureStatus({ active: false, phase: 'error', message: 'La captura se detuvo.', error: message || 'Error', tabId });
    } finally {
        if (_healingCleanup) _healingCleanup();
    }
}

export async function waitForCaptureQuota() {
    const elapsed = Date.now() - workerState.lastCaptureVisibleTabAt;
    const waitMs = Math.max(0, CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS - elapsed);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    workerState.lastCaptureVisibleTabAt = Date.now();
}

