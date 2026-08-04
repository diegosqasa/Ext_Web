import { ACTIONS } from './js/background/constants.js';

document.addEventListener('DOMContentLoaded', () => {
  const btnCaptureAll = document.getElementById('btnCaptureAll');
  const btnCaptureVisible = document.getElementById('btnCaptureVisible');
  const btnCaptureArea = document.getElementById('btnCaptureArea');
  const btnOpenViewer = document.getElementById('btnOpenViewer');
  const toastEl = document.getElementById('toast');
  const closePopup = document.getElementById('closePopup');

  // --- Manejo del cambio dinámico de Logo y Tema ---
// --- Manejo del cambio dinámico del icono oficial de la extensión ---
function updateThemeIcon() {
  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = isDark ? 'dark' : 'light';

  // Solo notifica al Service Worker para cambiar el icono de la barra del navegador
  chrome.runtime.sendMessage({ action: 'themeChanged', theme });
}

// Inicializar tema del icono al abrir
updateThemeIcon();

// Escuchar cambios de tema del sistema operativo
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeIcon);
}

  if (closePopup) {
    closePopup.addEventListener('click', () => window.close());
  }

  // Cerrar al hacer click fuera del contenido principal
  document.addEventListener('click', (e) => {
    const header = document.querySelector('.header');
    const panel = document.querySelector('.panel');
    if (!header.contains(e.target) && !panel.contains(e.target)) {
      window.close();
    }
  });

  function showToast(msg, type = "success") {
    if (!toastEl) return;
    
    let icon = "✅";
    if (type === "error") icon = "⚠️";
    if (msg.includes("realizada") || msg.includes("iniciada")) icon = "📸";
    if (msg.includes("Descarga")) icon = "📥";

    toastEl.innerHTML = `<span style="font-size:1.2em;">${icon}</span> <span>${msg.replace(/^[^\s\w]+/, '').trim()}</span>`;
    
    toastEl.className = "";
    if (type === "error") toastEl.classList.add("error");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 3000);
  }

  function setButtonsDisabled(disabled) {
    btnCaptureAll.disabled = disabled;
    btnCaptureVisible.disabled = disabled;
    if (btnCaptureArea) btnCaptureArea.disabled = disabled;
  }

  async function startCapture(action) {
    setButtonsDisabled(true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setButtonsDisabled(false);
      return;
    }

    try {
      await chrome.runtime.sendMessage({ action, tabId: tab.id });
      setTimeout(() => window.close(), 150);
    } catch (error) {
      showToast("Error al iniciar captura", "error");
      setButtonsDisabled(false);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === ACTIONS.captureStatus && message.status) {
      if (message.status.phase === 'error' && message.status.error) {
          let errorMsg = message.status.error;
          showToast(errorMsg, "error");
          setButtonsDisabled(false);
      } else if (message.status.phase === 'completed') {
          showToast("Captura realizada");
          setButtonsDisabled(false);
      }
    }
  });

  btnCaptureAll.addEventListener('click', () => startCapture(ACTIONS.captureAll));
  btnCaptureVisible.addEventListener('click', () => startCapture(ACTIONS.captureVisible));
  if (btnCaptureArea) {
    btnCaptureArea.addEventListener('click', () => startCapture(ACTIONS.captureArea));
  }
  if (btnOpenViewer) {
    btnOpenViewer.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: ACTIONS.openViewer });
      setTimeout(() => window.close(), 150);
    });
  }
});