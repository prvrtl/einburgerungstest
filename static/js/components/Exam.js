import { html, useState, useEffect, useMemo } from '../dom.js';
import { store } from '../store.js';
import { readDue, recordResult, readStreak, localDay } from '../srs.js';
import { SFX } from '../sfx.js';
import { simulateReadiness } from '../readiness.js';
import { reportAnswer, reportExam } from '../api.js';
import { sample, EXAM_GENERAL, EXAM_LAND, EXAM_PASS, EXAM_MINUTES, LAND_CODES } from '../util.js';
import { QuestionCard } from './QuestionCard.js';

const APP_HOST = 'einburgerungstest.sarmatt.online';

async function shareResult(score, total, passed, t) {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 630;
  const x = c.getContext('2d');
  const font = (spec) => spec + ' -apple-system, "Segoe UI", Roboto, sans-serif';
  x.fillStyle = '#06171d';
  x.fillRect(0, 0, 1200, 630);
  x.textAlign = 'center';
  x.font = '96px sans-serif';
  x.fillText(passed ? '🎉' : '😔', 600, 155);
  x.fillStyle = passed ? '#34a55b' : '#ef5350';
  x.font = font('bold 72px');
  x.fillText(passed ? t.passed : t.failed, 600, 270);
  x.fillStyle = '#e2f3f6';
  x.font = font('bold 140px');
  x.fillText(score + ' / ' + total, 600, 425);
  x.fillStyle = '#1a1a1a'; x.fillRect(480, 465, 80, 10);
  x.fillStyle = '#dd0000'; x.fillRect(560, 465, 80, 10);
  x.fillStyle = '#ffce00'; x.fillRect(640, 465, 80, 10);
  x.fillStyle = '#8bacb6';
  x.font = font('600 40px');
  x.fillText('Einbürgerungstest Trainer · ' + APP_HOST, 600, 560);

  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'einbuergerungstest.png', { type: 'image/png' });
  const text = (passed ? t.passed : t.failed) + ' ' + t.score(score, total);
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, url: 'https://' + APP_HOST });
    } else if (navigator.share) {
      await navigator.share({ text, url: 'https://' + APP_HOST });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'einbuergerungstest.png';
      a.click();
    }
  } catch (e) {} // user dismissed the share sheet
}

const fmtTime = (s) =>
  String(Math.max(0, Math.floor(s / 60))).padStart(2, '0') + ':' + String(Math.max(0, s % 60)).padStart(2, '0');

const recordExamLocal = (score, total) => {
  const h = store.read('examHistory', []);
  h.unshift({ d: Date.now(), s: score, n: total });
  store.write('examHistory', h.slice(0, 50));
};

function ExampleBox({ marks }) {
  const OPTS = ['2', '5', '7', '10'];
  return html`
    <div class="paper-exbox">
      <p class="paper-extext">Wie viele Tage hat die Woche?</p>
      ${OPTS.map((o, i) => html`
        <div key=${i} class="paper-exrow">
          ${marks[i] === 'circled'
            ? html`<span class="paper-circle"><span class="paper-box filled"></span></span>`
            : html`<span class=${'paper-box' + (marks[i] === 'filled' ? ' filled' : '')}>${marks[i] === 'cross' ? '✕' : ''}</span>`}
          <span>${o}</span>
        </div>`)}
    </div>`;
}

function PaperExam({ questions, onSubmit, onCancel, t, land }) {
  useEffect(() => {
    document.body.classList.add('papering');
    return () => document.body.classList.remove('papering');
  }, []);

  const [stage, setStage] = useState('cover');
  const [answers, setAnswers] = useState(() => Array(questions.length).fill(null));
  const [left, setLeft] = useState(EXAM_MINUTES * 60);
  const [confirmNeeded, setConfirmNeeded] = useState(false);
  const [nums] = useState(() => ({
    pruef: String(100000 + Math.floor(Math.random() * 900000)),
    bogen: String(4000000 + Math.floor(Math.random() * 1000000)) + ' EBT_H_1_V1_' + (LAND_CODES[land] || 'BE'),
  }));
  const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  useEffect(() => {
    if (stage !== 'test') return;
    const iv = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(iv);
  }, [stage]);
  useEffect(() => {
    if (stage === 'test' && left <= 0) onSubmit(answers);
  }, [left]);

  const setAns = (qi, idx) => {
    setAnswers((a) => {
      const c = a.slice();
      c[qi] = c[qi] === idx ? null : idx;
      return c;
    });
    setConfirmNeeded(false);
  };
  const answered = answers.filter((a) => a != null).length;
  const submit = () => {
    if (answered < questions.length && !confirmNeeded) {
      setConfirmNeeded(true);
      return;
    }
    onSubmit(answers);
  };
  const mm = String(Math.max(0, Math.floor(left / 60))).padStart(2, '0');
  const ss = String(Math.max(0, left % 60)).padStart(2, '0');
  const cancelBtn = html`<button class="paper-cancel" onClick=${onCancel}>✕ ${t.cancel}</button>`;

  if (stage === 'cover') {
    return html`
      <div class="screen"><div class="scrollpane paper-pane">
      <div class="paper">
        ${cancelBtn}
        <div class="paper-refs">
          <span>Prüfungsnr.:</span> ${nums.pruef}<br />
          <span>Testfragebogennr.:</span> ${nums.bogen}
        </div>
        <h1 class="paper-h1">Einbürgerungstest</h1>
        <div class="paper-h2">Testfragebogen</div>
        <table class="paper-table">
          <tbody>
            <tr><th>Prüfungsteilnehmer</th><td class="paper-note">Bitte korrigieren Sie falsche Angaben ggf. hier</td></tr>
            ${['Vorname', 'Familienname', 'geboren am', 'Geburtsort', 'Geburtsland', 'BAMF-Kennziffer'].map((f) => html`
              <tr key=${f}><th class="sub">${f}</th><td></td></tr>`)}
          </tbody>
        </table>
        <table class="paper-table">
          <tbody>
            <tr><th>aktuelle Anschrift</th><td class="paper-note">Bitte korrigieren Sie falsche Angaben ggf. hier</td></tr>
            ${['Care of bzw. c/o', 'Straße und Hausnr.', 'Postleitzahl und Ort'].map((f) => html`
              <tr key=${f}><th class="sub">${f}</th><td></td></tr>`)}
          </tbody>
        </table>
        <div class="paper-deco"><span class="d1"></span><span class="d2"></span><span class="d3"></span></div>
        <div class="paper-termin">
          <u>Prüfungstermin</u><br />
          Online-Simulation<br />
          am ${today}
        </div>
        <p class="paper-disclaimer">Simulation zu Übungszwecken — kein offizielles Dokument des BAMF</p>
        <div class="actions">
          <button class="btn" onClick=${() => setStage('anleitung')}>Weiter →</button>
        </div>
      </div>
      </div></div>`;
  }

  if (stage === 'anleitung') {
    return html`
      <div class="screen"><div class="scrollpane paper-pane">
      <div class="paper">
        ${cancelBtn}
        <div class="paper-runhead"><span>Einbürgerungstest</span><span>Prüfungsnr.: ${nums.pruef}</span><span>Seite 2</span></div>
        <div class="paper-band center">Anleitung</div>
        <p class="paper-text">
          In diesem Testfragebogen werden Sie 33 Fragen beantworten. Zu jeder Frage
          werden Ihnen vier verschiedene Antwortmöglichkeiten angeboten. Dabei ist
          immer nur <u>eine</u> der Antwortmöglichkeiten richtig! Setzen Sie bitte ein
          Kreuz in das Kästchen, das vor der richtigen Antwort steht.
        </p>
        <p class="paper-text">Dafür haben Sie 60 Minuten Zeit.</p>
        <p class="paper-text">
          Gewertet werden nur Antworten, die den folgenden Ausfüll- und
          Korrekturhinweisen des Bundesamtes entsprechen.
        </p>
        <div class="paper-extitle">Beispiel 1 – so kreuzt man an</div>
        <${ExampleBox} marks=${[null, null, 'cross', null]} />
        <div class="paper-extitle">Beispiel 2 – so korrigiert man</div>
        <p class="paper-text small">
          Wenn Sie schon ein Kreuz gemacht haben, aber die Antwort noch nachträglich
          ändern wollen, dann müssen Sie das Kästchen mit der nicht mehr gültigen
          Antwort deutlich ausfüllen und das neue Kreuz in das richtige Kästchen setzen.
        </p>
        <${ExampleBox} marks=${['cross', null, 'filled', null]} />
        <div class="paper-extitle">Beispiel 3 – so korrigiert man erneut</div>
        <p class="paper-text small">
          Es kann vorkommen, dass eine erst als falsch markierte Antwort doch als
          richtige Lösung angegeben werden soll. In diesem Fall füllen Sie bitte das
          Kästchen mit dem zweiten gesetzten Kreuz ebenfalls aus und umkreisen Sie das
          erste ausgefüllte Kästchen, welches nun wieder als richtige Antwort gelten soll.
        </p>
        <${ExampleBox} marks=${['filled', null, 'circled', null]} />
        <div class="actions">
          <button class="btn" onClick=${() => setStage('test')}>Test beginnen · 60:00</button>
        </div>
      </div>
      </div></div>`;
  }

  return html`
    <div class="screen"><div class="scrollpane paper-pane">
    <div class="paper">
      ${cancelBtn}
      <div class="paper-runhead"><span>Einbürgerungstest</span><span>Prüfungsnr.: ${nums.pruef} / Testfragebogennr.: ${nums.bogen.split(' ')[0]}</span></div>
      <div class="paper-band center">Testfragen</div>
      ${questions.map((q, qi) => html`
        <div key=${q.id}>
          ${qi % 3 === 0 && html`<div class="paper-seite">Seite ${4 + Math.floor(qi / 3)}</div>`}
          <div class="paper-q">
            <div class="paper-qnum">Frage ${qi + 1}</div>
            <p class="paper-qtext">${q.question}</p>
            ${q.image && html`<img class="paper-img" src=${'/img/' + q.image_file} alt="" />`}
            ${q.options.map((opt, i) => html`
              <button key=${i} class=${'paper-opt' + (answers[qi] === i + 1 ? ' checked' : '')} onClick=${() => setAns(qi, i + 1)}>
                <span class="paper-box">${answers[qi] === i + 1 ? '✕' : ''}</span>
                <span>${opt}</span>
              </button>`)}
          </div>
        </div>`)}
      <div class="paper-band center">Letzte Seite</div>
      <p class="paper-text">
        Bevor Sie das Testheft bei der Prüfungsaufsicht abgeben, unterschreiben Sie bitte hier:
      </p>
      <div class="paper-sign">
        <div class="paper-signline"></div>
        <div class="paper-signlabel">Datum / Unterschrift</div>
      </div>
      <div class="paper-official">
        <div class="center">– Nur vom Bundesamt auszufüllen –</div>
        <p>Testfragebogen wurde vollständig erfasst.</p>
      </div>
      <div class="paper-bar">
        <span class=${'paper-timer' + (left < 300 ? ' low' : '')}>⏱ ${mm}:${ss}</span>
        <span class="paper-count">${answered} / ${questions.length}</span>
        <button class="btn paper-submit" onClick=${submit}>Abgeben</button>
      </div>
      ${confirmNeeded && html`<p class="paper-warn">${t.unansweredWarn(questions.length - answered)}</p>`}
    </div>
    </div></div>`;
}

function Spark({ hist }) {
  const days = Object.keys(hist).sort().slice(-7);
  if (days.length < 2) return null;
  const vals = days.map((d) => hist[d]);
  const W = 120, H = 30;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const pts = vals.map((v, i) =>
    (i * (W / (vals.length - 1))).toFixed(1) + ',' + (H - 4 - ((v - min) / span) * (H - 8)).toFixed(1));
  return html`
    <svg class="spark" viewBox=${'0 0 ' + W + ' ' + H} width=${W} height=${H} aria-hidden="true">
      <polyline points=${pts.join(' ')} fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
}

export function Exam({ pool, t, locale, land, vocab, community, onStartDrill }) {
  const [questions, setQuestions] = useState(null);
  const [paper, setPaper] = useState(false);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [finished, setFinished] = useState(false);
  const [left, setLeft] = useState(EXAM_MINUTES * 60);
  const [timedOut, setTimedOut] = useState(false);
  const [examDate, setExamDate] = useState(() => store.read('examDate', ''));

  const readiness = useMemo(
    () => simulateReadiness(pool, land, community),
    [pool, land, community]
  );

  useEffect(() => {
    if (!readiness) return;
    const hist = store.read('readiness.history', {});
    hist[localDay()] = readiness.prob;
    const keys = Object.keys(hist).sort();
    while (keys.length > 30) delete hist[keys.shift()];
    store.write('readiness.history', hist);
  }, [readiness]);

  const changeExamDate = (v) => {
    setExamDate(v);
    store.write('examDate', v);
  };
  const coach = useMemo(() => {
    if (!examDate) return null;
    const days = Math.ceil((new Date(examDate + 'T23:59:59') - Date.now()) / 864e5);
    if (days <= 0) return null;
    const seenSet = new Set(store.read('practice.seen', []));
    const scoped = pool.filter((q) => !q.land || q.land === land);
    const backlog = scoped.filter((q) => !seenSet.has(q.id)).length + readDue().size;
    return { days, quota: Math.max(5, Math.ceil(backlog / days)) };
  }, [examDate, pool, land]);

  useEffect(() => {
    if (!questions || paper || finished) return;
    const iv = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(iv);
  }, [questions, paper, finished]);

  // fanfare or lament once the result screen appears (any exam mode)
  useEffect(() => {
    if (!finished || !questions) return;
    const score = answers.filter((a, i) => a === questions[i].correct).length;
    SFX[score >= EXAM_PASS ? 'win' : 'fail']();
  }, [finished]);

  useEffect(() => {
    if (!questions || paper || finished || left > 0) return;
    const newAnswers = selected != null ? [...answers, selected] : answers;
    const score = newAnswers.filter((a, i) => a === questions[i].correct).length;
    reportExam(score >= EXAM_PASS);
    recordExamLocal(score, questions.length);
    setAnswers(newAnswers);
    setTimedOut(true);
    setFinished(true);
  }, [left]);

  const start = (asPaper) => {
    const general = pool.filter((q) => !q.land);
    const landQs = pool.filter((q) => q.land === land);
    setQuestions([...sample(general, EXAM_GENERAL), ...sample(landQs, EXAM_LAND)]);
    setPaper(asPaper === true);
    setIdx(0);
    setAnswers([]);
    setSelected(null);
    setFinished(false);
    setLeft(EXAM_MINUTES * 60);
    setTimedOut(false);
  };
  const reset = () => {
    setQuestions(null);
    setPaper(false);
    setFinished(false);
  };
  const submitPaper = (paperAnswers) => {
    setAnswers(paperAnswers);
    const score = paperAnswers.filter((a, i) => a === questions[i].correct).length;
    questions.forEach((q, i) => {
      reportAnswer(q.id, paperAnswers[i] === q.correct);
      recordResult(q.id, paperAnswers[i] === q.correct);
    });
    reportExam(score >= EXAM_PASS);
    recordExamLocal(score, questions.length);
    setFinished(true);
  };

  const q = questions && !paper && !finished ? questions[idx] : null;

  const choose = (i) => {
    if (!q || selected != null) return;
    setSelected(i);
    SFX[i === q.correct ? 'correct' : 'wrong']();
    recordResult(q.id, i === q.correct);
    reportAnswer(q.id, i === q.correct);
  };
  const nextQ = () => {
    if (!q) return;
    const newAnswers = [...answers, selected];
    setAnswers(newAnswers);
    setSelected(null);
    if (idx + 1 >= questions.length) {
      const score = newAnswers.filter((a, i) => a === questions[i].correct).length;
      reportExam(score >= EXAM_PASS);
      recordExamLocal(score, questions.length);
      setFinished(true);
    } else {
      setIdx(idx + 1);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!q || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (selected == null) {
        const i = 'abcd'.indexOf(k) !== -1 ? 'abcd'.indexOf(k) : '1234'.indexOf(k);
        if (i !== -1) { choose(i + 1); e.preventDefault(); }
      } else if (k === 'enter' || k === ' ' || k === 'n') {
        nextQ(); e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!questions) {
    const history = store.read('examHistory', []).slice(0, 8);
    const daily = readStreak();
    const startDrill = () => {
      store.write('drill', readiness.worst);
      store.write('practice.category', 'drill');
      onStartDrill();
    };
    return html`
      <div class="screen">
        <div class="scrollpane"><div class="fit">
        <div class="card result">
        <div class="big">📝</div>
        <h2 style=${{ color: 'inherit' }}>${t.examTitle}</h2>
        <p>${t.examIntro1(EXAM_GENERAL, EXAM_LAND, land)}</p>
        <p>${t.examIntro2(EXAM_PASS, EXAM_GENERAL + EXAM_LAND)}</p>

        ${readiness && html`
          <div class="ready">
            <div class=${'ready-num ' + (readiness.prob >= 75 ? 'ok' : readiness.prob >= 50 ? 'mid' : 'bad')}>
              ${readiness.prob}%
            </div>
            <div class="eh-label">${t.readiness}</div>
            <${Spark} hist=${store.read('readiness.history', {})} />
            <p class="ready-note">${t.readinessNote}</p>
            ${readiness.worst.length > 0 && html`
              <button class="btn ghost" onClick=${startDrill}>${t.drillCta(readiness.worst.length)}</button>`}
          </div>`}

        <div class="coach">
          <label class="coach-date">
            ${t.examDateLabel}
            <input class="select date" type="date" value=${examDate}
                   onChange=${(e) => changeExamDate(e.target.value)} />
          </label>
          ${coach && html`
            <p class="coach-line">
              ${t.coachLine(coach.days, coach.quota)}<br />
              ${daily.count >= coach.quota
                ? html`<b class="ok">${t.onTrack}</b>`
                : html`<b class="mid">${t.behindBy(coach.quota - daily.count)}</b>`}
            </p>`}
        </div>

        <div class="actions" style=${{ justifyContent: 'center', flexDirection: 'column', alignItems: 'center' }}>
          <button class="btn" onClick=${() => start(false)}>${t.startExam}</button>
          <button class="btn ghost" onClick=${() => start(true)}>${t.paperMode}</button>
        </div>
        <p style=${{ fontSize: '.8rem', marginTop: '10px' }}>${t.paperNote}</p>
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
        </div>
        </div></div>
      </div>`;
  }

  if (paper && !finished) {
    return html`<${PaperExam} questions=${questions} onSubmit=${submitPaper} onCancel=${reset} t=${t} land=${land} />`;
  }

  if (finished) {
    const score = answers.filter((a, i) => a === questions[i].correct).length;
    const passed = score >= EXAM_PASS;
    const wrongOnes = questions.map((q, i) => ({ q, a: answers[i] })).filter((x) => x.a !== x.q.correct);
    return html`
      <div class="screen">
        <div class="scrollpane">
        <div class=${'card result ' + (passed ? 'pass' : 'fail')}>
          <div class="big">${passed ? '🎉' : '😔'}</div>
          <h2>${passed ? t.passed : t.failed}</h2>
          <div class="score">${t.score(score, questions.length)}</div>
          <p>${t.passNote(EXAM_PASS)}</p>
          ${!paper && html`<p>${timedOut ? t.timeUp + ' · ' : ''}${t.timeUsed(fmtTime(EXAM_MINUTES * 60 - Math.max(0, left)))}</p>`}
          <div class="actions" style=${{ justifyContent: 'center' }}>
            <button class="btn" onClick=${() => start(paper)}>${t.tryAgain}</button>
            <button class="btn ghost" onClick=${() => shareResult(score, questions.length, passed, t)}>${t.share}</button>
          </div>
        </div>
        ${wrongOnes.length > 0 && html`
          <h3 style=${{ margin: '22px 4px 10px' }}>${t.mistakes(wrongOnes.length)}</h3>
          ${wrongOnes.map(({ q, a }) => html`
            <div key=${q.id} class="card review-item">
              <${QuestionCard} q=${q} selected=${a == null ? 0 : a} onSelect=${() => {}} t=${t} locale=${locale} vocab=${vocab} />
            </div>`)}`}
        </div>
      </div>`;
  }

  const answeredCount = answers.length;

  return html`
    <div class="screen">
      <div class="exam-head">
        <span>${t.questionOf(idx + 1, questions.length)}</span>
        <span class=${'exam-timer' + (left < 300 ? ' low' : '')}>⏱ ${fmtTime(left)}</span>
        <span>${t.correctSoFar(answers.filter((a, i) => a === questions[i].correct).length)}</span>
      </div>
      <div class="progress"><div style=${{ width: (100 * answeredCount) / questions.length + '%' }}></div></div>
      <div class="cardpane">
        <div class="card qcard">
          <div class="qwrap" key=${q.id}>
            <${QuestionCard} q=${q} selected=${selected} onSelect=${choose} t=${t} locale=${locale} vocab=${vocab} />
          </div>
          ${selected != null && html`
            <div class="actions">
              <button class="btn" onClick=${nextQ}>
                ${idx + 1 >= questions.length ? t.finishExam : t.nextQuestion}
              </button>
            </div>`}
        </div>
      </div>
    </div>`;
}
