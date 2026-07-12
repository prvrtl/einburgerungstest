import { html, useState, useEffect, useMemo, useCallback } from '../dom.js';
import { store } from '../store.js';
import { DECKS, readMistakes, readDue, recordResult, readStreak, DAILY_GOAL } from '../srs.js';
import { SFX } from '../sfx.js';
import { filterPool } from '../util.js';
import { reportAnswer } from '../api.js';
import { Filters } from './Filters.js';
import { QuestionCard } from './QuestionCard.js';

export function Practice({ pool, categories, t, locale, land, hardest, vocab }) {
  const [category, setCategory] = useState(() => {
    const saved = store.read('practice.category', 'all');
    return saved === 'berlin' ? 'land' : saved;
  });
  const [seen, setSeen] = useState(() => new Set(store.read('practice.seen', [])));
  const [current, setCurrent] = useState(null);
  const [selected, setSelected] = useState(null);
  const [counters, setCounters] = useState(() => store.read('practice.counters', { answered: 0, correct: 0 }));
  const [deckIds, setDeckIds] = useState(() => (DECKS[category] || readMistakes)());

  useEffect(() => { store.write('practice.category', category); }, [category]);
  useEffect(() => { store.write('practice.seen', [...seen]); }, [seen]);
  useEffect(() => { store.write('practice.counters', counters); }, [counters]);
  useEffect(() => { if (DECKS[category]) setDeckIds(DECKS[category]()); }, [category]);

  const filtered = useMemo(
    () => filterPool(pool, category, deckIds, land, hardest),
    [pool, category, deckIds, land, hardest]
  );

  const pickNext = useCallback((seenSet) => {
    setSelected(null);
    setCurrent((prev) => {
      // Deck filters ignore the seen set: their questions stay in rotation
      // until they leave the deck, however often they were seen.
      const base = DECKS[category] ? filtered : filtered.filter((q) => !seenSet.has(q.id));
      if (!base.length) return null;
      const cands = base.length > 1 && prev ? base.filter((q) => q.id !== prev.id) : base;
      return cands[Math.floor(Math.random() * cands.length)];
    });
  }, [filtered, category]);

  // Advance only on explicit signals (mount, next, category/land change) —
  // never on incidental re-renders, which used to swap the question mid-view
  // and made unanswered questions reappear later as "repeats".
  const [qseq, setQseq] = useState(0);
  useEffect(() => { pickNext(seen); }, [qseq, category, land]);

  const answer = (idx) => {
    if (selected != null) return;
    setSelected(idx);
    const ok = idx === current.correct;
    SFX[ok ? 'correct' : 'wrong']();
    setCounters((c) => ({ answered: c.answered + 1, correct: c.correct + ok }));
    setSeen((s) => new Set(s).add(current.id));
    recordResult(current.id, ok);
    reportAnswer(current.id, ok);
  };

  // In deck modes, advancing re-reads the deck so questions that left it
  // drop out; the qseq bump triggers the pick with the fresh deck applied.
  const next = () => {
    if (DECKS[category]) setDeckIds(DECKS[category]());
    setQseq((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (current && selected == null) {
        const i = 'abcd'.indexOf(k) !== -1 ? 'abcd'.indexOf(k) : '1234'.indexOf(k);
        if (i !== -1) { answer(i + 1); e.preventDefault(); }
      } else if (current && selected != null && (k === 'enter' || k === ' ' || k === 'n')) {
        next(); e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const resetProgress = () => {
    setSeen(new Set());
    setCounters({ answered: 0, correct: 0 });
    setQseq((n) => n + 1);
  };

  const remaining = DECKS[category]
    ? filtered.length
    : filtered.filter((q) => !seen.has(q.id)).length;
  const mistakesCount = store.read('mistakes', []).length;
  const dueCount = readDue().size;
  const drillCount = store.read('drill', []).length;
  const hardestCount = hardest ? filterPool(pool, 'hardest', null, land, hardest).length : 0;
  const daily = readStreak();

  return html`
    <div class="screen">
      <div class="filterrow">
        <${Filters} category=${category} setCategory=${setCategory} categories=${categories} t=${t} mistakesCount=${mistakesCount} dueCount=${dueCount} drillCount=${drillCount} land=${land} hardestCount=${hardestCount} />
      </div>

      <div class="cardpane">
        <div class="card qcard">
          ${current
            ? html`
              <div class="qwrap" key=${current.id}>
                <${QuestionCard} q=${current} selected=${selected} onSelect=${answer} t=${t} locale=${locale} vocab=${vocab} />
              </div>`
            : DECKS[category]
            ? html`
              <div class="done">
                <h3>🙌</h3>
                <p>${category === 'mistakes' ? t.noMistakes : category === 'drill' ? t.drillDone : t.noDue}</p>
              </div>`
            : html`
              <div class="done">
                <h3>${t.poolComplete}</h3>
                <p>${t.poolCompleteBody(filtered.length)}</p>
                <button class="btn" onClick=${resetProgress}>${t.startOver}</button>
              </div>`}
        </div>
      </div>

      <div class="actionsbar">
        <span class="chips">🔥 ${daily.streak} · ${daily.count}/${DAILY_GOAL}${current ? ' · ⏳ ' + remaining : ''}</span>
        ${current && selected != null && html`<button class="btn" onClick=${next}>${t.nextQuestion}</button>`}
      </div>
    </div>`;
}
