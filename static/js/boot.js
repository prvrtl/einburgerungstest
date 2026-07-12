// Classic (non-module) script, loaded in <head> so it runs before first
// paint: applies the saved theme before anything renders (avoids a flash)
// and registers the service worker. Kept separate from the module bundle so
// a `script-src 'self'` CSP still allows it as a plain classic script.
try {
  var _t = localStorage.getItem('theme');
  if (_t === 'light' || _t === 'dark') document.documentElement.setAttribute('data-theme', _t);
} catch (e) {}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
