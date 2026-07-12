import { html, useState } from '../dom.js';
import { store } from '../store.js';
import { readStreak, DAILY_GOAL } from '../srs.js';
import { EXAM_PASS } from '../util.js';
import { Mastery } from './Mastery.js';

export function Progress({ pool, categories, t, land, community, onOpenStats, onPickCategory }) {
  const [, force] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const counters = store.read('practice.counters', { answered: 0, correct: 0 });
  const wrong = counters.answered - counters.correct;
  const acc = counters.answered ? Math.round((100 * counters.correct) / counters.answered) : 0;
  const daily = readStreak();
  const history = store.read('examHistory', []).slice(0, 8);
  const qstate = store.read('qstate', {});
  const scoped = pool.filter((q) => !q.land || q.land === land);
  const masteryRows = [...categories.map((c) => ({ key: c, name: c })), { key: 'land', name: land }]
    .map(({ key, name }) => {
      const qs = key === 'land' ? scoped.filter((q) => q.land) : scoped.filter((q) => q.category === key);
      return { key, name, total: qs.length, done: qs.filter((q) => qstate[q.id] === 1).length };
    });
  const cl = community && community.answered > 0
    ? t.communityLine(community.answered.toLocaleString(), community.accuracy, community.exams_taken, community.exams_passed)
    : null;

  const resetAll = () => {
    if (!confirmReset) { setConfirmReset(true); return; }
    store.write('practice.seen', []);
    store.write('practice.counters', { answered: 0, correct: 0 });
    setConfirmReset(false);
    force((n) => n + 1);
  };

  return html`
    <div class="screen">
      <div class="scrollpane stack">
        <div class="brand">
          <img class="appicon" src="/icons/icon-192.png" alt="" />
          <div>
            <div class="title">Einbürgerungstest Trainer</div>
            <div class="subtitle">${t.subtitle}</div>
          </div>
        </div>
        <p class="daily">${t.dailyLine(daily.streak, daily.count, DAILY_GOAL)}</p>
        <div class="stats">
          <div class="stat"><b>${counters.answered}</b><span>${t.answered}</span></div>
          <div class="stat"><b class="ok">${counters.correct}</b><span>${t.correctL}</span></div>
          <div class="stat"><b class="bad">${wrong}</b><span>${t.incorrectL}</span></div>
          <div class="stat"><b>${acc}%</b><span>${t.accuracy}</span></div>
        </div>
        <${Mastery} rows=${masteryRows} onPick=${onPickCategory} t=${t} />
        ${history.length > 0 && html`
          <div class="exam-history">
            <div class="eh-label">${t.recentAttempts}</div>
            <div class="eh-items">
              ${history.map((h, i) => html`
                <span key=${i} class=${'eh-item ' + (h.s >= EXAM_PASS ? 'ok' : 'bad')}
                      title=${new Date(h.d).toLocaleDateString()}>
                  ${h.s}/${h.n}
                </span>`)}
            </div>
          </div>`}
        ${cl && html`
          <button class="community linkish" onClick=${onOpenStats}>
            ${cl.map((part, i) => i % 2 ? html`<b key=${i}>${part}</b>` : part)}
          </button>`}
        <button class="btn ghost wide" onClick=${resetAll} onBlur=${() => setConfirmReset(false)}>
          ${confirmReset ? t.resetConfirm : t.resetProgress}
        </button>
        <p class="support">
          <span class="flag" aria-hidden="true"><span></span><span></span></span>
          ${t.supportLine}${' '}
          <a href="https://sternenkofund.org/en/donate" target="_blank" rel="noopener">
            <img class="fund-ico" src="/icons/sternenko-fund.png" alt="" width="16" height="16" />${t.supportFund}</a>.
        </p>
      </div>
    </div>`;
}
