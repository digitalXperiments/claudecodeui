import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
// Self-hosted fonts (font-display: swap), bundled into the entry CSS instead of
// a render-blocking cross-origin Google Fonts stylesheet. Only the weights the
// UI uses: Encode Sans (UI) 400-700, Merriweather (chat prose) 400/700 + italics.
import '@fontsource/encode-sans/400.css'
import '@fontsource/encode-sans/500.css'
import '@fontsource/encode-sans/600.css'
import '@fontsource/encode-sans/700.css'
import '@fontsource/merriweather/400.css'
import '@fontsource/merriweather/700.css'
import '@fontsource/merriweather/400-italic.css'
import '@fontsource/merriweather/700-italic.css'
import './index.css'
// KaTeX CSS is loaded on demand by Markdown.tsx when a message contains math.

// A production tab can outlive a frontend rebuild. Vite then tries to lazy
// load a hashed chunk that the new build no longer references. Refresh once to
// obtain the new entry graph; the sessionStorage guard prevents a reload loop
// when the server is still unavailable or serving an incomplete build.
if (import.meta.env.PROD && typeof window !== 'undefined') {
  const preloadReloadKey = 'cloudcli:preload-reload-attempt';
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(preloadReloadKey);
    } catch {
      // Ignore unavailable browser storage.
    }
  }, 10000);
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    try {
      if (sessionStorage.getItem(preloadReloadKey) === window.location.pathname) return;
      sessionStorage.setItem(preloadReloadKey, window.location.pathname);
    } catch {
      // If storage is unavailable, the event is still prevented and the error
      // boundary remains usable instead of causing an uncontrolled loop.
      return;
    }
    window.location.reload();
  });
}

// Initialize i18n
import i18n, { i18nReady } from './i18n/config.js'

// Register the service worker (PWA + Web Push) once, after load and when the
// main thread is idle, so it never competes with the startup bundle.
if ('serviceWorker' in navigator) {
  const registerServiceWorker = () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  };
  const scheduleRegistration = () => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(registerServiceWorker, { timeout: 5000 });
    } else {
      window.setTimeout(registerServiceWorker, 1000);
    }
  };
  if (document.readyState === 'complete') {
    scheduleRegistration();
  } else {
    window.addEventListener('load', scheduleRegistration, { once: true });
  }
}

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// English is bundled, so the default path renders synchronously. A saved
// non-English language loads its locale chunks first (the static shell in
// index.html stays visible meanwhile), so the first render is never a flash of
// English or a suspended tree. On failure, render anyway with English fallback.
if (i18n.hasLoadedNamespace('common')) {
  renderApp()
} else {
  i18nReady.then(renderApp, renderApp)
}
