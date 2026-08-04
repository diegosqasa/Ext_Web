const PROTOCOL_VERSION = "1.3";
const MAX_DIM = 200000;
const DESKTOP_HEADER_MAX_DIM = 16384;
const MIN_CAPTURE_DIM = 100; // Dimensiones mínimas válidas

// Cache de logo con estado
let _logoBitmap = null;
let _logoLoadPromise = null;
let _logoLoadFailed = false;

async function _loadLogo() {
    if (_logoBitmap || _logoLoadFailed) return;
    if (_logoLoadPromise) return _logoLoadPromise;
    
    _logoLoadPromise = (async () => {
        try {
            const logoUrl = chrome.runtime.getURL('Media/icon-dark-128.png');
            const resp = await fetch(logoUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            _logoBitmap = await createImageBitmap(blob);
            
            // Validar que el logo tenga dimensiones válidas
            if (_logoBitmap.width < 10 || _logoBitmap.height < 10) {
                console.warn('[CaptureEngine] Logo con dimensiones inválidas:', _logoBitmap.width, _logoBitmap.height);
                _logoBitmap.close();
                _logoBitmap = null;
            }
        } catch (err) {
            console.warn('[CaptureEngine] Error cargando logo:', err.message);
            _logoLoadFailed = true;
            _logoBitmap = null;
        } finally {
            _logoLoadPromise = null;
        }
    })();
    
    return _logoLoadPromise;
}

const DEBUGGER_ATTACH_TIMEOUT_MS = 5000;
const DEBUGGER_SEND_TIMEOUT_MS = 8000;

function _attach(tabId) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.warn('[CaptureEngine] Timeout en attach para tab', tabId);
            reject(new Error(`Timeout attaching debugger to tab ${tabId}`));
        }, DEBUGGER_ATTACH_TIMEOUT_MS);
        
        chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

function _detach(tabId) {
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            console.debug('[CaptureEngine] Timeout en detach para tab', tabId);
            resolve(); // Resolver de todas formas para evitar cuelgues
        }, 3000);
        
        chrome.debugger.detach({ tabId }, () => {
            clearTimeout(timeoutId);
            resolve();
        });
    });
}

function _send(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            console.warn('[CaptureEngine] Timeout enviando', method, 'a tab', tabId);
            reject(new Error(`Timeout sending ${method} to tab ${tabId}`));
        }, DEBUGGER_SEND_TIMEOUT_MS);
        
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(result);
            }
        });
    });
}

async function _getPageDimensions(tabId) {
    // Medición in-page primero: Page.getLayoutMetrics.cssContentSize se infla en
    // páginas con contenido dinámico/ads (ej. #google_vignette). El clamp evita
    // intentar capturar bitmaps absurdos que ralentizan enormemente la captura.
    try {
        const { result } = await _send(tabId, 'Runtime.evaluate', {
            returnByValue: true,
            expression: `(() => {
                const e = document.documentElement;
                const b = document.body;
                const width = Math.max(
                    e.scrollWidth, b ? b.scrollWidth : 0,
                    e.offsetWidth, b ? b.offsetWidth : 0,
                    e.clientWidth
                );
                const height = Math.max(
                    e.scrollHeight, b ? b.scrollHeight : 0,
                    e.offsetHeight, b ? b.offsetHeight : 0,
                    e.clientHeight
                );
                return { width: Math.min(width, ${MAX_DIM}), height: Math.min(height, ${MAX_DIM}) };
            })()`
        });
        const v = result && result.value;
        if (v && v.width > 0 && v.height > 0) {
            return { width: Math.ceil(v.width), height: Math.ceil(v.height) };
        }
    } catch {}
    try {
        const metrics = await _send(tabId, 'Page.getLayoutMetrics');
        const w = Math.ceil(metrics.cssContentSize?.width || metrics.contentSize?.width || metrics.cssLayoutViewport?.width || 1200);
        const h = Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || metrics.cssLayoutViewport?.height || 800);
        if (w > 0 && h > 0) return { width: Math.min(w, MAX_DIM), height: Math.min(h, MAX_DIM) };
    } catch {}
    return { width: 1200, height: 800 };
}

async function _freezeScroll(tabId) {
    await _send(tabId, "Runtime.evaluate", {
        expression: `
            (() => {
                const e = document.documentElement;
                const b = document.body;
                window.__fp_ov_e = e && e.style ? e.style.overflow : '';
                window.__fp_ov_b = b && b.style ? b.style.overflow : '';
                if (e && e.style) e.style.overflow = 'hidden';
                if (b && b.style) b.style.overflow = 'hidden';
            })()
        `
    }).catch(() => {});
}

async function _restoreScroll(tabId) {
    await _send(tabId, "Runtime.evaluate", {
        expression: `
            (() => {
                const e = document.documentElement;
                const b = document.body;
                if (e && e.style) e.style.overflow = window.__fp_ov_e || '';
                if (b && b.style) b.style.overflow = window.__fp_ov_b || '';
                delete window.__fp_ov_e;
                delete window.__fp_ov_b;
            })()
        `
    }).catch(() => {});
}

function _pad(n) { return String(n).padStart(2, '0'); }

function _formatDate(d) {
    let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    let ampm = h >= 12 ? 'p.m.' : 'a.m.';
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return `${_pad(d.getDate())}/${_pad(d.getMonth() + 1)}/${d.getFullYear()}, ${h12}:${_pad(m)}:${_pad(s)} ${ampm}`;
}

function _wrapText(ctx, text, maxWidth) {
    const chars = Array.from(text);
    const lines = [];
    let currentLine = '';
    for (let i = 0; i < chars.length; i++) {
        const testLine = currentLine + chars[i];
        if (ctx.measureText(testLine).width > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = chars[i];
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
}

// Header COMPLETO (solo fallback para imágenes > 16384px donde el escritorio
// omite el header por protección OOM). Codifica PNG lossless (regla de oro).
async function _drawHeaderOnBitmap(bitmap, evidenceId, url, browserLabel, osLabel) {
    const HEADER_EXTRA = 100;
    const srcWidth = bitmap.width;
    const srcHeight = bitmap.height;
    const canvas = new OffscreenCanvas(srcWidth, srcHeight + HEADER_EXTRA);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#002b55';
    ctx.fillRect(0, 0, srcWidth, HEADER_EXTRA);
    ctx.fillStyle = '#FF6B00';
    ctx.fillRect(0, HEADER_EXTRA - 4, srcWidth, 4);

    if (_logoBitmap && _logoBitmap.width > 0) {
        const logoW = 100;
        const logoH = Math.round(logoW * (_logoBitmap.height / _logoBitmap.width));
        ctx.drawImage(_logoBitmap, 12, 8, logoW, logoH);
    }

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px sans-serif';
    ctx.fillText('Evidencia de prueba QA', 100, 14);

    ctx.font = '600 16px sans-serif';
    const urlLines = _wrapText(ctx, 'Origen: ' + url, srcWidth - 130);
    for (let i = 0; i < urlLines.length; i++) {
        ctx.fillText(urlLines[i], 100, 41 + i * 22);
    }

    const metaY = 68 + (urlLines.length - 1) * 22;
    ctx.font = '400 17px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    const evLabel = evidenceId || 'ID: ---';
    ctx.fillText(`${evLabel} | 📅 ${_formatDate(new Date())} | 🌐 ${browserLabel} | 💻 ${osLabel}`, 100, metaY);

    ctx.drawImage(bitmap, 0, 0, srcWidth, srcHeight, 0, HEADER_EXTRA, srcWidth, srcHeight);

    return canvas.convertToBlob({ type: 'image/png' });
}

// Header MINIMAL para portapapeles (rápido): canvas reducido, sin logo, texto básico.
// El escritorio aplica el header corporativo completo de forma asíncrona sobre el PNG raw.
const MINIMAL_HEADER_MAX_W = 1600;

async function _drawMinimalHeader(bitmap, evidenceId, url, browserLabel, osLabel) {
    const HEADER_EXTRA = 100;
    const scale = Math.min(1, MINIMAL_HEADER_MAX_W / bitmap.width);
    const srcWidth = Math.max(1, Math.round(bitmap.width * scale));
    const srcHeight = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(srcWidth, srcHeight + HEADER_EXTRA);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#002b55';
    ctx.fillRect(0, 0, srcWidth, HEADER_EXTRA);
    ctx.fillStyle = '#FF6B00';
    ctx.fillRect(0, HEADER_EXTRA - 4, srcWidth, 4);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px sans-serif';
    ctx.fillText('Evidencia de prueba QA', 16, 14);

    const displayUrl = url || '';
    const truncatedUrl = displayUrl.length > 90 ? displayUrl.slice(0, 89) + '…' : displayUrl;
    ctx.font = '500 15px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillText(truncatedUrl, 16, 43);

    const evLabel = evidenceId || 'ID: ---';
    ctx.font = '400 14px sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillText(`${evLabel} | 📅 ${_formatDate(new Date())} | 🌐 ${browserLabel} | 💻 ${osLabel}`, 16, 70);

    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, HEADER_EXTRA, srcWidth, srcHeight);

    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

function _blobToDataUrl(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

async function _resetEmulation(tabId) {
    await _send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await _send(tabId, 'Emulation.setScrollbarsHidden', { hidden: false }).catch(() => {});
}

function _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function _fetchNextEvId() {
    try {
        const resp = await fetch('http://127.0.0.1:3000/api/peek-sequence');
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.success ? data.label : null;
    } catch {
        return null;
    }
}

export async function isAvailable() {
    return typeof chrome.debugger !== 'undefined';
}

export async function captureFullPage(tabId, browserInfo) {
    await _attach(tabId);
    await _send(tabId, 'Page.enable').catch(() => {});
    await _send(tabId, 'DOM.enable').catch(() => {});

    await _send(tabId, 'Page.bringToFront').catch(() => {});
    await _send(tabId, 'Runtime.evaluate', { expression: 'window.scrollTo(0,0)' }).catch(() => {});

    const dims = await _getPageDimensions(tabId);
    const width = Math.ceil(dims.width || 1200);
    const height = Math.ceil(dims.height || 800);

    await _send(tabId, 'Runtime.evaluate', {
        expression: `
            (() => {
                const d = document.createElement('div');
                d.id = '__sqa_overlay';
                d.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647;overflow:hidden;';
                document.documentElement.appendChild(d);
            })()
        `
    }).catch(() => {});
    await _delay(50);

    await _send(tabId, 'Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height
    });
    await _send(tabId, 'Emulation.setVisibleSize', { width, height }).catch(() => {});
    await _send(tabId, 'Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
    await _freezeScroll(tabId);
    await _delay(120);

    await _send(tabId, 'Runtime.evaluate', {
        expression: `var o = document.getElementById('__sqa_overlay'); if(o) o.remove();`
    }).catch(() => {});
    await _delay(50);

    const { data: base64 } = await _send(tabId, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 }
    });

    await _send(tabId, 'Runtime.evaluate', {
        expression: `var o = document.getElementById('__sqa_overlay'); if(o) o.remove();`
    }).catch(() => {});

    await _restoreScroll(tabId);
    await _resetEmulation(tabId);
    await _detach(tabId);

    return await _processImage(base64, browserInfo);
}

export async function captureVisible(tabId, browserInfo) {
    await _attach(tabId);
    await _send(tabId, 'Page.enable').catch(() => {});
    await _send(tabId, 'DOM.enable').catch(() => {});

    await _freezeScroll(tabId);

    const { data: base64 } = await _send(tabId, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true
    });

    await _restoreScroll(tabId);
    await _detach(tabId);

    return await _processImage(base64, browserInfo);
}

export async function captureArea(tabId, clip, browserInfo) {
    await _attach(tabId);
    await _send(tabId, 'Page.enable').catch(() => {});
    await _send(tabId, 'DOM.enable').catch(() => {});

    const { data: base64 } = await _send(tabId, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    });

    await _detach(tabId);

    return await _processImage(base64, browserInfo);
}

async function _processImage(base64, browserInfo) {
    // Cargar blob raw y consultar el siguiente ID en paralelo
    const [rawBlob, evId] = await Promise.all([
        (async () => {
            const blob = await (await fetch('data:image/png;base64,' + base64)).blob();
            return blob;
        })(),
        _fetchNextEvId()
    ]);

    let bitmap;
    try {
        bitmap = await createImageBitmap(rawBlob);
    } catch (err) {
        console.error('[CaptureEngine] Error creando bitmap:', err.message);
        throw new Error('No se pudo procesar la imagen capturada');
    }

    // Validación de dimensiones mínimas
    if (bitmap.width < MIN_CAPTURE_DIM || bitmap.height < MIN_CAPTURE_DIM) {
        console.warn('[CaptureEngine] Captura con dimensiones inválidas:', bitmap.width, 'x', bitmap.height);
        bitmap.close();
        throw new Error(`Captura inválida: ${bitmap.width}x${bitmap.height}px (mínimo ${MIN_CAPTURE_DIM}px)`);
    }

    // Validación de dimensiones máximas
    if (bitmap.width > MAX_DIM || bitmap.height > MAX_DIM) {
        console.warn('[CaptureEngine] Captura excede dimensiones máximas:', bitmap.width, 'x', bitmap.height);
        bitmap.close();
        throw new Error(`Captura demasiado grande: ${bitmap.width}x${bitmap.height}px (máximo ${MAX_DIM}px)`);
    }

    const browserVal = browserInfo ? `${browserInfo.name} v${browserInfo.version}` : 'N/A';
    const osVal = browserInfo ? browserInfo.os : 'N/A';
    const url = browserInfo?.url || '';

    // Fallback para imágenes enormes (>16384px): el escritorio omite el header
    // (protección OOM en _processHeaderForCapture e image-worker), así que la
    // extensión lo dibuja completo (PNG lossless) y lo marca como ya header.
    if (bitmap.width > DESKTOP_HEADER_MAX_DIM || bitmap.height > DESKTOP_HEADER_MAX_DIM) {
        try {
            const headedBlob = await _drawHeaderOnBitmap(bitmap, evId, url, browserVal, osVal);
            bitmap.close();
            const headedDataUrl = await _blobToDataUrl(headedBlob);
            return { blob: headedBlob, dataUrl: headedDataUrl, hasHeaderAlready: true };
        } catch (headerErr) {
            console.error('[CaptureEngine] Error dibujando header completo:', headerErr.message);
            bitmap.close();
            throw headerErr;
        }
    }

    // Header minimal (rápido, ~200ms) solo para el dataUrl del portapapeles.
    // El PNG raw viaja sin header al escritorio, que aplica el header corporativo completo.
    try {
        const minimalBlob = await _drawMinimalHeader(bitmap, evId, url, browserVal, osVal);
        bitmap.close();
        const dataUrl = await _blobToDataUrl(minimalBlob);
        return { blob: rawBlob, dataUrl, hasHeaderAlready: false };
    } catch (headerErr) {
        console.error('[CaptureEngine] Error dibujando header minimal:', headerErr.message);
        bitmap.close();
        throw headerErr;
    }
}

export async function init() {
    // El logo solo se necesita en el fallback de imágenes enormes (_drawHeaderOnBitmap).
    await _loadLogo();
}
