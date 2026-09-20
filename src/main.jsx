import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

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
import './i18n/config.js'

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
