import { html, useState, useEffect } from '../dom.js';
import { LETTERS } from '../util.js';

const WORD_RE = /([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*)/g;

export function QText({ q, vocab, locale, t }) {
  const [active, setActive] = useState(null);
  const canSpeak = typeof speechSynthesis !== 'undefined';

  useEffect(() => () => { if (canSpeak) speechSynthesis.cancel(); }, [q.id]);

  const speak = () => {
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    const text = q.question + '. ' + q.options.map((o, i) => LETTERS[i] + ': ' + o).join('. ');
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    speechSynthesis.speak(u);
  };

  const entryFor = (word) => {
    if (!vocab || locale === 'de') return null;
    const lw = word.toLowerCase();
    return vocab[lw] || vocab[lw.replace(/(en|es|er|e|n|s)$/, '')] || null;
  };

  const parts = q.question.split(WORD_RE);
  return html`
    <p class="qtext">
      ${parts.map((part, i) => {
        const entry = i % 2 === 1 ? entryFor(part) : null;
        if (!entry) return part;
        return html`
          <button key=${i} class=${'vocab' + (active === i ? ' open' : '')} onClick=${() => setActive(active === i ? null : i)}>
            ${part}
            ${active === i && html`<span class="vocab-pop">${entry[locale] || entry.en}</span>`}
          </button>`;
      })}
      ${canSpeak && html`
        <button class="speak" onClick=${speak} aria-label=${t.readAloud} title=${t.readAloud}>🔊</button>`}
    </p>`;
}

export function QuestionCard({ q, selected, onSelect, t, locale, vocab }) {
  const revealed = selected != null;
  const [showTrans, setShowTrans] = useState(false);
  const translation = locale !== 'de' && q.trans && q.trans[locale];
  const explanation = q.expl && (q.expl[locale] || q.expl.de);
  return html`
    <div>
      <div class="qmeta">
        <span class="badge">${q.category}</span>
        <span>${t.questionN(q.num || q.id)}</span>
      </div>
      <${QText} q=${q} vocab=${vocab} locale=${locale} t=${t} />
      ${q.image && html`<img class="qimg" src=${'/img/' + q.image_file} alt="" />`}
      <div class="options">
        ${q.options.map((opt, i) => {
          const idx = i + 1;
          let cls = 'opt';
          if (revealed) {
            if (idx === q.correct) cls += ' correct';
            else if (idx === selected) cls += ' wrong';
          }
          return html`
            <button key=${i} class=${cls} disabled=${revealed} onClick=${() => onSelect(idx)}>
              <span class="letter">${LETTERS[i]}</span>
              <span>${opt}</span>
            </button>`;
        })}
      </div>
      ${translation && html`
        <div class="trans">
          <button class="transbtn" onClick=${() => setShowTrans(!showTrans)}>
            ${showTrans ? t.hideTranslation : t.showTranslation}
          </button>
          ${showTrans && html`<p class="transtext">${translation}</p>`}
        </div>`}
      <div aria-live="polite">
        ${revealed && html`
          <p class=${'verdict ' + (selected === q.correct ? 'ok' : 'bad')}>
            ${selected === q.correct ? t.correctBang : t.wrongAnswer(LETTERS[q.correct - 1])}
          </p>`}
        ${revealed && explanation && html`
          <div class="expl">
            <div class="expl-label">${t.explanation}</div>
            <p>${explanation}</p>
          </div>`}
      </div>
    </div>`;
}
