/**
 * Evidencias SQA — background/utils.js
 */

import { captureStatus, captureInProgress } from './state.js';
import { ACTIONS } from './constants.js';

export function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || '');
}

export function isExpectedCaptureError(error) {
    const message = getErrorMessage(error).toLowerCase();
    return (
        message.includes('frame with id 0 is showing error page') ||
        message.includes('showing error page') ||
        message.includes('cannot access contents of url') ||
        message.includes('the tab was closed') ||
        message.includes('extensions gallery cannot be scripted')
    );
}

export function isMissingTabError(error) {
    const message = getErrorMessage(error);
    return message.includes('No tab with id');
}

export function safeSetBadgeText(details) {
    return chrome.action.setBadgeText(details).catch((error) => {
        if (!isMissingTabError(error)) console.warn('setBadgeText failed:', error);
    });
}

export function safeSetBadgeBackgroundColor(details) {
    return chrome.action.setBadgeBackgroundColor(details).catch((error) => {
        if (!isMissingTabError(error)) console.warn('setBadgeBackgroundColor failed:', error);
    });
}

export function syncBadge(tabIdOverride = captureStatus.tabId) {
    const tabId = tabIdOverride;
    if (!tabId) return;

    let text = '';
    let color = '#FF6B00';

    if (captureStatus.active) {
        if (captureStatus.phase === 'processing') {
            text = '...';
        } else {
            const value = Math.max(0, Math.min(99, Math.round(captureStatus.progress || 0)));
            text = `${value}%`;
        }
    } else if (captureStatus.phase === 'completed') {
        text = 'OK';
        color = '#27ae60';
    } else if (captureStatus.phase === 'error') {
        text = '!';
        color = '#e74c3c';
    }

    safeSetBadgeText({ text, tabId });
    if (text) safeSetBadgeBackgroundColor({ color, tabId });
}

export function updateCaptureStatus(patch) {
    const oldPhase = captureStatus.phase;
    Object.assign(captureStatus, patch);
    syncBadge();
    if (patch.phase && patch.phase !== oldPhase) {
        chrome.runtime.sendMessage({ action: ACTIONS.captureStatus, status: { ...captureStatus } }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
        });
    }
}
