import { html, useState, useEffect, useMemo } from './dom.js';
import { store, exportProgress, importProgress } from './store.js';
import { api } from './api.js';
import { SFX, soundOn } from './sfx.js';
import { applyTheme } from './theme.js';
import { STRINGS, LOCALES, detectLocale } from './i18n.js';
import { CATEGORY_ORDER } from './util.js';
import { Practice } from './components/Practice.js';
import { Exam } from './components/Exam.js';
import { Review } from './components/Review.js';
import { Progress } from './components/Progress.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

function App() {
  const [pool, setPool] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('practice');
  const [community, setCommunity] = useState(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [locale, setLocale] = useState(detectLocale);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });
  const [land, setLand] = useState(() => store.read('land', 'Berlin'));
  const [landChosen, setLandChosen] = useState(() => store.read('land', null) != null);
  // stable identity — a fresh Set each render makes children re-pick questions
  const hardest = useMemo(
    () => (community && community.hardest && community.hardest.length
      ? new Set(community.hardest.map((h) => h.id))
      : null),
    [community]
  );
  const t = STRINGS[locale];
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

  const changeLocale = (l) => {
    setLocale(l);
    try { localStorage.setItem('lang', l); } catch (e) {}
  };
  const changeTheme = (th) => {
    setTheme(th);
    try { localStorage.setItem('theme', th); } catch (e) {}
    applyTheme(th);
  };
  const changeLand = (l) => {
    setLand(l);
    setLandChosen(true);
    store.write('land', l);
  };

  const [sound, setSound] = useState(soundOn);
  const changeSound = (v) => {
    setSound(v);
    store.write('sound', v);
    if (v) SFX.correct();
  };

  const pushOK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [reminder, setReminder] = useState(() => store.read('reminder', ''));
  const changeReminder = async (val) => {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!val) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
          await sub.unsubscribe();
        }
        setReminder('');
        store.write('reminder', '');
        return;
      }
      if ((await Notification.requestPermission()) !== 'granted') return;
      const { key } = await api('/api/push/key');
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
      const appKey = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      const utcHour = ((+val) + Math.round(new Date().getTimezoneOffset() / 60) + 24) % 24;
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON(), utcHour, lang: locale }),
      });
      setReminder(val);
      store.write('reminder', val);
    } catch (e) {}
  };
  useEffect(() => { applyTheme(theme); }, []);

  const [vocab, setVocab] = useState(null);

  useEffect(() => {
    api('/api/questions').then(setPool).catch((e) => setError(String(e)));
    fetch('/api/stats').then((r) => r.json()).then(setCommunity).catch(() => {});
    fetch('/vocab.json').then((r) => r.json()).then((list) => {
      const map = {};
      list.forEach((e) => { map[e.de.toLowerCase().replace(/^(der|die|das)\s+/, '')] = e; });
      setVocab(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let hadController = !!navigator.serviceWorker.controller;
    const onChange = () => {
      if (hadController) setUpdateReady(true);
      hadController = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    // iOS keeps installed PWAs suspended for days — actively check for a
    // new version whenever the app comes back to the foreground.
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker.getRegistration()
        .then((reg) => reg && reg.update())
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (error) {
    return html`<div class="app"><div class="boot">${t.loadError}</div></div>`;
  }
  if (!pool) {
    return html`<div class="app"><div class="boot">${t.loading}</div></div>`;
  }

  const categories = CATEGORY_ORDER.filter((c) => pool.some((q) => q.category === c));
  const lands = [...new Set(pool.filter((q) => q.land).map((q) => q.land))].sort((a, b) => a.localeCompare(b, 'de'));

  const GEAR_PATH = 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z';
  const TAB_ICONS = {
    practice: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>`,
    exam: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2h6v4H9z" /><path d="M15 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 13l2 2 4-4" /></svg>`,
    review: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>`,
    progress: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18" /><path d="M7 17V9" /><path d="M12 17V4" /><path d="M17 17v-6" /></svg>`,
  };

  return html`
    <div class="app">
      <main class="content">

      ${settingsOpen && html`
        <div class="sheet-backdrop" onClick=${() => setSettingsOpen(false)}>
          <div class="sheet" role="dialog" aria-label=${t.settings} onClick=${(e) => e.stopPropagation()}>
            <div class="sheet-head">
              <b>${t.settings}</b>
              <button class="sheet-close" onClick=${() => setSettingsOpen(false)} aria-label="Close">✕</button>
            </div>
            <div class="setting-row">
              <span>${t.language}</span>
              <div class="seg">
                ${LOCALES.map(([code, label]) => html`
                  <button key=${code} class=${'segbtn' + (locale === code ? ' active' : '')} onClick=${() => changeLocale(code)}>
                    ${label}
                  </button>`)}
              </div>
            </div>
            <div class="setting-row">
              <span>${t.theme}</span>
              <div class="seg">
                ${[['auto', t.themeAuto], ['light', t.themeLight], ['dark', t.themeDark]].map(([val, label]) => html`
                  <button key=${val} class=${'segbtn' + (theme === val ? ' active' : '')} onClick=${() => changeTheme(val)}>
                    ${label}
                  </button>`)}
              </div>
            </div>
            <div class="setting-row">
              <span>${t.landLabel}</span>
              <select class="select land-select" value=${land} onChange=${(e) => changeLand(e.target.value)}>
                ${lands.map((l) => html`<option key=${l} value=${l}>${l}</option>`)}
              </select>
            </div>
            <div class="setting-row">
              <span>${t.soundLabel}</span>
              <div class="seg">
                <button class=${'segbtn' + (sound ? ' active' : '')} onClick=${() => changeSound(true)}>${t.soundOn}</button>
                <button class=${'segbtn' + (!sound ? ' active' : '')} onClick=${() => changeSound(false)}>${t.reminderOff}</button>
              </div>
            </div>
            ${pushOK && html`
              <div class="setting-row">
                <span>${t.reminderLabel}</span>
                <select class="select land-select" value=${reminder} onChange=${(e) => changeReminder(e.target.value)}>
                  <option value="">${t.reminderOff}</option>
                  ${[8, 12, 18, 20].map((h) => html`
                    <option key=${h} value=${h}>${String(h).padStart(2, '0')}:00</option>`)}
                </select>
              </div>`}
            <div class="setting-row">
              <span>${t.backupLabel}</span>
              <div class="backup-btns">
                <button class="segbtn" onClick=${exportProgress}>${t.exportBtn}</button>
                <label class="segbtn">
                  ${t.importBtn}
                  <input type="file" accept="application/json" hidden
                         onChange=${(e) => e.target.files[0] && importProgress(e.target.files[0])} />
                </label>
              </div>
            </div>
            <div class="about">
              <b>Einbürgerungstest Trainer</b> — ${t.subtitle}
              <p>
                Data based on the official BAMF „Gesamtfragenkatalog Leben in Deutschland /
                Einbürgerungstest, Stand 07.05.2025". Question set from the open-source MIT project${' '}
                <a href="https://github.com/flexsurfer/einburgerungstest" target="_blank" rel="noopener">flexsurfer/einburgerungstest</a>.
              </p>
              <p>
                This site is not endorsed by or affiliated with the BAMF (Bundesamt für Migration und
                Flüchtlinge). Answers are community-sourced and intended for practice purposes only.
                Translations and explanations are AI-generated study aids — verify anything critical
                against official sources.
              </p>
            </div>
          </div>
        </div>`}

      ${mode === 'practice' && html`<${Practice} pool=${pool} categories=${categories} t=${t} locale=${locale} land=${land} hardest=${hardest} vocab=${vocab} />`}
      ${mode === 'exam' && html`<${Exam} pool=${pool} t=${t} locale=${locale} land=${land} vocab=${vocab} community=${community} onStartDrill=${() => setMode('practice')} />`}
      ${mode === 'review' && html`<${Review} pool=${pool} categories=${categories} t=${t} locale=${locale} land=${land} hardest=${hardest} vocab=${vocab} />`}
      ${mode === 'progress' && html`<${Progress} pool=${pool} categories=${categories} t=${t} land=${land} community=${community}
        onOpenStats=${() => setStatsOpen(true)}
        onPickCategory=${(key) => { store.write('practice.category', key); setMode('practice'); }} />`}
      </main>

      <nav class="tabbar">
        ${[['practice', t.practice], ['exam', t.exam], ['review', t.review], ['progress', t.progressTab]].map(([key, label]) => html`
          <button key=${key} class=${'tab' + (mode === key ? ' active' : '')} onClick=${() => setMode(key)}>
            ${TAB_ICONS[key]}
            ${label}
          </button>`)}
        <button class=${'tab' + (settingsOpen ? ' active' : '')} onClick=${() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" />
            <path d=${GEAR_PATH} />
          </svg>
          ${t.settingsTab}
        </button>
      </nav>

      ${!landChosen && html`
        <div class="sheet-backdrop">
          <div class="sheet" role="dialog" aria-label=${t.chooseLand}>
            <div class="sheet-head"><b>${t.chooseLand}</b></div>
            <p class="sheet-note">${t.chooseLandNote}</p>
            <div class="land-list">
              ${lands.map((l) => html`
                <button key=${l} class="landbtn" onClick=${() => changeLand(l)}>${l}</button>`)}
            </div>
          </div>
        </div>`}

      ${updateReady && html`
        <div class="hint update">
          <span>${t.updateReady}</span>
          <button class="hintbtn" onClick=${() => location.reload()}>${t.updateAction}</button>
        </div>`}

      ${isIOS && !standalone && !hintDismissed && html`
        <div class="hint">
          <span>${t.installHint}</span>
          <button onClick=${() => setHintDismissed(true)} aria-label="Dismiss">✕</button>
        </div>`}

      ${statsOpen && community && html`
        <div class="sheet-backdrop" onClick=${() => setStatsOpen(false)}>
          <div class="sheet" role="dialog" aria-label=${t.statsTitle} onClick=${(e) => e.stopPropagation()}>
            <div class="sheet-head">
              <b>${t.statsTitle}</b>
              <button class="sheet-close" onClick=${() => setStatsOpen(false)} aria-label="Close">✕</button>
            </div>
            <div class="stats">
              <div class="stat"><b>${community.answered.toLocaleString()}</b><span>${t.answered}</span></div>
              <div class="stat"><b>${community.accuracy}%</b><span>${t.accuracy}</span></div>
              <div class="stat"><b>${community.exams_taken}</b><span>${t.examsL}</span></div>
              <div class="stat"><b class="ok">${community.exams_passed}</b><span>${t.passedL}</span></div>
            </div>
            ${community.hardest && community.hardest.length > 0 && html`
              <div class="m-label">${t.hardestTitle}</div>
              ${community.hardest.slice(0, 10).map((h) => {
                const q = pool.find((p) => p.id === h.id);
                return q && html`
                  <div key=${h.id} class="hard-row">
                    <span class="hard-acc">${Math.round(h.accuracy)}%</span>
                    <span>
                      <span class="hard-meta">${t.questionN(q.num || q.id)}${q.land ? ' · ' + q.land : ''}</span>
                      ${q.question}
                    </span>
                  </div>`;
              })}`}
          </div>
        </div>`}

    </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${ErrorBoundary}><${App} /></${ErrorBoundary}>`);
