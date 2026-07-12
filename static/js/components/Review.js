import { html, useState, useMemo } from '../dom.js';
import { readMistakes, readDue, DECKS } from '../srs.js';
import { filterPool } from '../util.js';
import { Filters } from './Filters.js';
import { QuestionCard } from './QuestionCard.js';

export function Review({ pool, categories, t, locale, land, hardest, vocab }) {
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [mistakes] = useState(readMistakes);
  const [due] = useState(readDue);
  const [drill] = useState(DECKS.drill);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scoped = pool.filter((q) => !q.land || q.land === land);
    if (/^\d+$/.test(needle)) return scoped.filter((q) => (q.num || q.id) === +needle);
    const deck = category === 'due' ? due : category === 'drill' ? drill : mistakes;
    let qs = filterPool(pool, category, deck, land, hardest);
    if (!needle) return qs;
    return qs.filter((q) =>
      q.question.toLowerCase().includes(needle) ||
      q.options.some((o) => o.toLowerCase().includes(needle)) ||
      (q.trans && Object.values(q.trans).some((tr) => tr.toLowerCase().includes(needle)))
    );
  }, [pool, category, query, mistakes, due, drill, land, hardest]);
  const hardestCount = hardest ? filterPool(pool, 'hardest', null, land, hardest).length : 0;
  return html`
    <div class="screen">
      <input class="search" type="search" placeholder=${t.searchPlaceholder}
             value=${query} onInput=${(e) => setQuery(e.target.value)} />
      <${Filters} category=${category} setCategory=${setCategory} categories=${categories} t=${t} mistakesCount=${mistakes.size} dueCount=${due.size} drillCount=${drill.size} land=${land} hardestCount=${hardestCount} />
      <p class="review-count">${filtered.length ? t.reviewCount(filtered.length) : t.noResults}</p>
      <div class="scrollpane">
        ${filtered.map((q) => html`
          <div key=${q.id} class="card review-item">
            <${QuestionCard} q=${q} selected=${q.correct} onSelect=${() => {}} t=${t} locale=${locale} vocab=${vocab} />
          </div>`)}
      </div>
    </div>`;
}
