// Runs only on the landing pages (/, /en, /uk). If this page is loaded as an
// already-installed PWA — iOS home-screen apps freeze their start_url at
// add-to-home-screen time, and Android WebAPKs only update it lazily — send
// the user straight to the app shell instead of the marketing page. Normal
// browser visits (including crawlers) are never in standalone/fullscreen
// display mode, so the landing page and its SEO are unaffected.
(function () {
  var standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
  if (standalone) {
    location.replace('/app');
  }
})();
