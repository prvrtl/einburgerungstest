(function () {
  'use strict';
  const { useState, useEffect, useMemo, useCallback, useRef } = React;
  const html = htm.bind(React.createElement);

  let _token = null;

  async function getToken() {
    if (_token) return _token;
    const res = await fetch('/api/token', {
      headers: { 'X-Requested-With': 'einbuergerungstest-quiz' },
    });
    if (!res.ok) throw new Error('token ' + res.status);
    _token = (await res.json()).token;
    return _token;
  }

  async function api(path, opts = {}, retry = true) {
    let token = null;
    try {
      token = await getToken();
    } catch (e) {}
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Quiz-Token': token } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 403 && retry) {
      _token = null;
      return api(path, opts, false);
    }
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return res.json();
  }

  const reportAnswer = (id, correct) =>
    api('/api/stats/answer', { method: 'POST', body: JSON.stringify({ id, correct }) }).catch(() => {});
  const reportExam = (passed) =>
    api('/api/stats/exam', { method: 'POST', body: JSON.stringify({ passed }) }).catch(() => {});

  const store = {
    read(key, fallback) {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        return v == null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    },
  };

  const readMistakes = () => new Set(store.read('mistakes', []));

  // Leitner boxes: wrong answers land in box 1, each correct answer moves the
  // question up a box. A question is due again after SRS_DAYS[box] days.
  const SRS_DAYS = [0, 0, 1, 3, 7, 30];

  const readDue = () => {
    const srs = store.read('srs', {});
    const now = Date.now();
    const due = new Set();
    for (const id of Object.keys(srs)) {
      const [box, last] = srs[id];
      if (now - last >= SRS_DAYS[box] * 864e5) due.add(+id);
    }
    return due;
  };

  // Deck-style practice filters: membership is dynamic, so they bypass the
  // seen set and refresh their snapshot when advancing to the next question.
  const DECKS = {
    mistakes: readMistakes,
    due: readDue,
    drill: () => new Set(store.read('drill', [])),
  };

  const DAILY_GOAL = 10;
  const localDay = (offsetMs = 0) => new Date(Date.now() - offsetMs).toLocaleDateString('sv');

  // One entry point for "the user answered question id": feeds the mistakes
  // deck, per-question mastery state, and the daily streak counter.
  const recordResult = (id, correct) => {
    const m = readMistakes();
    if (correct) m.delete(id);
    else m.add(id);
    store.write('mistakes', [...m]);

    const qstate = store.read('qstate', {});
    qstate[id] = correct ? 1 : 0;
    store.write('qstate', qstate);

    const srs = store.read('srs', {});
    const prevBox = srs[id] ? srs[id][0] : 0;
    srs[id] = [correct ? Math.min(prevBox + 1, 5) : 1, Date.now()];
    store.write('srs', srs);

    if (correct) {
      const drill = store.read('drill', []);
      if (drill.includes(id)) store.write('drill', drill.filter((x) => x !== id));
    }

    const today = localDay();
    const d = store.read('daily', { date: '', count: 0, streak: 0, lastGoal: '' });
    if (d.date !== today) { d.date = today; d.count = 0; }
    d.count++;
    if (d.count === DAILY_GOAL) {
      d.streak = d.lastGoal === localDay(864e5) ? d.streak + 1 : 1;
      d.lastGoal = today;
    }
    store.write('daily', d);
  };

  const readStreak = () => {
    const d = store.read('daily', { date: '', count: 0, streak: 0, lastGoal: '' });
    const today = localDay();
    return {
      count: d.date === today ? d.count : 0,
      streak: d.lastGoal === today || d.lastGoal === localDay(864e5) ? d.streak : 0,
    };
  };

  // ---- 8-bit sound effects: square-wave chiptunes synthesized on the fly.
  let _actx = null;
  const soundOn = () => store.read('sound', true);

  function playNotes(notes) {
    if (!soundOn()) return;
    try {
      _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
      if (_actx.state === 'suspended') _actx.resume();
      const now = _actx.currentTime;
      notes.forEach(([f, t, d]) => {
        const osc = _actx.createOscillator();
        const gain = _actx.createGain();
        osc.type = 'square';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + t);
        gain.gain.exponentialRampToValueAtTime(0.1, now + t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t + d);
        osc.connect(gain).connect(_actx.destination);
        osc.start(now + t);
        osc.stop(now + t + d + 0.02);
      });
    } catch (e) {}
  }

  const SFX = {
    // quick upward blip: A5 → E6
    correct: () => playNotes([[880, 0, .09], [1318.5, .09, .16]]),
    // low double-buzz down: A3 → E3
    wrong: () => playNotes([[220, 0, .12], [164.8, .13, .22]]),
    // victory fanfare: C E G C' G C'
    win: () => playNotes([
      [523.25, 0, .12], [659.25, .12, .12], [783.99, .24, .12],
      [1046.5, .36, .2], [783.99, .58, .1], [1046.5, .68, .34],
    ]),
    // sad chromatic descent: G F E D
    fail: () => playNotes([
      [392, 0, .18], [349.23, .2, .18], [329.63, .4, .18], [293.66, .6, .45],
    ]),
  };

  // ---- Readiness engine: estimate P(correct) per question, then Monte-Carlo
  // simulate the real exam draw (30 general + 3 state, pass at 17).
  // Calibrated guesses per Leitner box when the last answer was correct.
  const BOX_P = [0.6, 0.65, 0.75, 0.85, 0.9, 0.95];
  const P_AFTER_WRONG = 0.3;

  function questionP(id, srs, qstate, pq, fallback) {
    const s = srs[id];
    if (s) {
      if (qstate[id] === 0) return P_AFTER_WRONG;
      return BOX_P[Math.min(s[0], 5)];
    }
    const tally = pq && pq[id];
    if (tally) return Math.min(0.95, Math.max(0.25, tally[1] / tally[0]));
    return fallback;
  }

  function simulateReadiness(pool, land, community) {
    const srs = store.read('srs', {});
    const qstate = store.read('qstate', {});
    const pq = community && community.pq;
    const fallback = community && community.accuracy
      ? Math.max(0.45, Math.min(0.8, community.accuracy / 100))
      : 0.6;

    const general = pool.filter((q) => !q.land);
    const landQs = pool.filter((q) => q.land === land);
    if (general.length < EXAM_GENERAL || landQs.length < EXAM_LAND) return null;
    const pGen = general.map((q) => questionP(q.id, srs, qstate, pq, fallback));
    const pLand = landQs.map((q) => questionP(q.id, srs, qstate, pq, fallback));

    const N = 5000;
    let passes = 0;
    const gi = general.map((_, i) => i);
    const li = landQs.map((_, i) => i);
    for (let it = 0; it < N; it++) {
      let score = 0;
      for (let i = 0; i < EXAM_GENERAL; i++) {
        const j = i + Math.floor(Math.random() * (gi.length - i));
        const tmp = gi[i]; gi[i] = gi[j]; gi[j] = tmp;
        if (Math.random() < pGen[gi[i]]) score++;
      }
      for (let i = 0; i < EXAM_LAND; i++) {
        const j = i + Math.floor(Math.random() * (li.length - i));
        const tmp = li[i]; li[i] = li[j]; li[j] = tmp;
        if (Math.random() < pLand[li[i]]) score++;
      }
      if (score >= EXAM_PASS) passes++;
    }

    const scored = general.map((q, i) => ({ id: q.id, p: pGen[i] }))
      .concat(landQs.map((q, i) => ({ id: q.id, p: pLand[i] })))
      .sort((a, b) => a.p - b.p);
    return {
      prob: Math.round((100 * passes) / N),
      worst: scored.slice(0, 15).map((s) => s.id),
    };
  }

  // Everything the app remembers about a user, for backup/restore.
  const PROGRESS_KEYS = [
    'practice.seen', 'practice.counters', 'practice.category', 'mistakes',
    'qstate', 'srs', 'daily', 'examHistory', 'readiness.history', 'drill',
    'examDate', 'land', 'lang', 'theme', 'sound', 'reminder',
  ];

  const exportProgress = () => {
    const data = {};
    PROGRESS_KEYS.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v != null) data[k] = v;
    });
    const blob = new Blob([JSON.stringify({ app: 'ebt', v: 1, data }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'einbuergerungstest-progress.json';
    a.click();
  };

  const importProgress = (file) => {
    file.text().then((txt) => {
      const parsed = JSON.parse(txt);
      if (parsed.app !== 'ebt' || !parsed.data) return;
      Object.keys(parsed.data).forEach((k) => {
        if (PROGRESS_KEYS.includes(k)) {
          try { localStorage.setItem(k, parsed.data[k]); } catch (e) {}
        }
      });
      location.reload();
    }).catch(() => {});
  };

  const THEME_COLORS = { light: '#e9f5f7', dark: '#06171d' };

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      const scheme = theme !== 'auto' ? theme
        : (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
      m.setAttribute('content', THEME_COLORS[scheme]);
    });
  }

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const sample = (arr, n) => shuffle(arr).slice(0, n);
  const LETTERS = ['A', 'B', 'C', 'D'];

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const VOICE_OK = !!SpeechRec && typeof speechSynthesis !== 'undefined';
  const SR_LANGS = { de: 'de-DE', en: 'en-US', uk: 'uk-UA' };

  // What the recognizer may return when someone says a letter/number — per
  // locale, including common mishearings and spelling-alphabet words.
  const VOICE_ANSWERS = {
    de: [
      ['a', 'ah', 'anton', 'eins'],
      ['b', 'be', 'beh', 'berta', 'zwei'],
      ['c', 'ce', 'zeh', 'tse', 'cäsar', 'drei'],
      ['d', 'de', 'deh', 'dora', 'vier'],
    ],
    en: [
      ['a', 'ay', 'hey', 'one'],
      ['b', 'be', 'bee', 'two'],
      ['c', 'see', 'sea', 'three'],
      ['d', 'dee', 'four'],
    ],
    uk: [
      ['a', 'а', 'ей', 'один'],
      ['b', 'б', 'бе', 'бі', 'два'],
      ['c', 'с', 'це', 'сі', 'три'],
      ['d', 'д', 'де', 'ді', 'чотири'],
    ],
  };
  const VOICE_NEXT = {
    de: ['weiter', 'nächste'],
    en: ['next', 'continue'],
    uk: ['далі', 'наступне'],
  };
  const VOICE_REPEAT = {
    de: ['wiederholen', 'wiederhole', 'nochmal'],
    en: ['repeat', 'again'],
    uk: ['повтори', 'повторити', 'ще раз'],
  };

  function matchVoice(transcript, locale) {
    const words = transcript.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (/^[1-4]$/.test(w)) return { answer: +w };
      for (let i = 0; i < 4; i++) {
        if (VOICE_ANSWERS[locale][i].includes(w)) return { answer: i + 1 };
      }
    }
    const joined = words.join(' ');
    if (VOICE_NEXT[locale].some((c) => joined.includes(c))) return { next: true };
    if (VOICE_REPEAT[locale].some((c) => joined.includes(c))) return { repeat: true };
    return null;
  }

  const STRINGS = {
    de: {
      subtitle: 'Leben in Deutschland — Übungsquiz',
      practice: 'Üben',
      exam: 'Prüfung',
      review: 'Übersicht',
      progressTab: 'Fortschritt',
      settingsTab: 'Mehr',
      resetConfirm: 'Wirklich zurücksetzen?',
      allCategories: 'Alle Kategorien',
      landOnly: (l) => 'Nur ' + l,
      landLabel: 'Bundesland',
      answered: 'Beantwortet',
      correctL: 'Richtig',
      incorrectL: 'Falsch',
      accuracy: 'Quote',
      questionN: (id) => 'Frage ' + id,
      nextQuestion: 'Nächste Frage →',
      resetProgress: 'Zurücksetzen',
      poolComplete: '🎉 Alle Fragen geschafft!',
      poolCompleteBody: (n) => 'Du hast alle ' + n + ' Fragen dieser Auswahl beantwortet.',
      startOver: 'Neu starten',
      remaining: (n) => n + (n === 1 ? ' ungesehene Frage übrig' : ' ungesehene Fragen übrig'),
      correctBang: '✓ Richtig!',
      wrongAnswer: (l) => '✗ Falsch — richtige Antwort: ' + l,
      showTranslation: 'Übersetzung anzeigen',
      hideTranslation: 'Übersetzung ausblenden',
      explanation: 'Erklärung',
      examTitle: 'Prüfungssimulation',
      examIntro1: (g, b, l) => g + ' allgemeine Fragen + ' + b + ' Fragen zu ' + l + '.',
      examIntro2: (p, t) => 'Bestanden ab ' + p + ' von ' + t + ' richtigen Antworten.',
      startExam: 'Prüfung starten',
      paperMode: '📄 Papiermodus — wie die echte Prüfung',
      paperNote: 'Alle 33 Aufgaben auf einem Bogen, 60 Minuten, Auswertung erst nach der Abgabe.',
      cancel: 'Abbrechen',
      unansweredWarn: (n) => n + ' Aufgaben sind noch offen — zum Abgeben erneut tippen.',
      finishExam: 'Prüfung abschließen',
      questionOf: (i, n) => 'Frage ' + i + ' von ' + n,
      correctSoFar: (n) => n + ' richtig bisher',
      passed: 'Bestanden!',
      failed: 'Nicht bestanden',
      score: (s, n) => s + ' / ' + n + ' richtig',
      passNote: (p) => 'Bestehensgrenze: ' + p + ' richtige Antworten.',
      timeUsed: (s) => 'Benötigte Zeit: ' + s,
      timeUp: 'Zeit abgelaufen!',
      tryAgain: 'Nochmal versuchen',
      share: 'Ergebnis teilen',
      statsTitle: 'Community-Statistik',
      examsL: 'Prüfungen',
      passedL: 'Bestanden',
      hardestTitle: 'Am häufigsten falsch beantwortet',
      mistakes: (n) => 'Deine Fehler (' + n + ')',
      reviewCount: (n) => n + ' Fragen — richtige Antworten markiert',
      communityLine: (a, acc, e, p) => ['Community: ', a, ' Antworten, ', acc, '% richtig · ', e, ' Prüfungen, ', p, ' bestanden'],
      settings: 'Einstellungen',
      language: 'Sprache',
      theme: 'Design',
      themeAuto: 'System',
      themeLight: 'Hell',
      themeDark: 'Dunkel',
      recentAttempts: 'Letzte Versuche',
      readiness: 'Bestehenswahrscheinlichkeit heute',
      readinessNote: 'Simulation der echten Prüfung auf Basis deines Lernstands.',
      drillCta: (n) => 'Schwächste Fragen üben (' + n + ')',
      drillFilter: (n) => 'Gezieltes Training (' + n + ')',
      drillDone: 'Training geschafft — stark!',
      examDateLabel: 'Prüfungstermin',
      reminderLabel: 'Tägliche Erinnerung',
      reminderOff: 'Aus',
      soundLabel: 'Sound',
      soundOn: 'An',
      backupLabel: 'Fortschritt',
      exportBtn: 'Sichern',
      importBtn: 'Wiederherstellen',
      coachLine: (d, q) => 'Noch ' + d + ' Tage · Empfehlung: ' + q + ' Fragen/Tag',
      onTrack: '✓ Auf Kurs für heute',
      behindBy: (n) => 'Heute noch ' + n + ' Fragen',
      searchPlaceholder: 'Suche oder Fragenummer…',
      mistakesFilter: (n) => 'Meine Fehler (' + n + ')',
      noMistakes: 'Keine Fehler gespeichert — weiter so!',
      hardestFilter: (n) => 'Community-Stolpersteine (' + n + ')',
      dueFilter: (n) => 'Wiederholen fällig (' + n + ')',
      noDue: 'Nichts zum Wiederholen fällig — alles sitzt!',
      mastery: 'Fortschritt nach Kategorie',
      dailyLine: (s, c, g) => 'Serie: ' + s + ' 🔥 · Heute: ' + c + '/' + g,
      readAloud: 'Vorlesen',
      voiceMode: 'Sprachmodus',
      vListening: 'Höre zu…',
      vSpeaking: 'Lese vor…',
      voiceHint: 'Sage A, B, C oder D · „weiter" · „wiederholen"',
      supportLine: 'Nützlich? Das beste Dankeschön ist eine Spende an die Verteidiger der Ukraine —',
      supportFund: 'Sternenko Fund',
      chooseLand: 'Wähle dein Bundesland',
      chooseLandNote: 'In der Prüfung gibt es 3 Fragen zu deinem Bundesland. Du kannst es später in den Einstellungen ändern.',
      noResults: 'Keine Treffer',
      installHint: 'App installieren: Teilen antippen, dann „Zum Home-Bildschirm"',
      updateReady: 'Neue Version verfügbar',
      updateAction: 'Aktualisieren',
      loadError: 'Fragen konnten nicht geladen werden. Bitte Seite neu laden.',
      loading: 'Fragen werden geladen…',
    },
    en: {
      subtitle: 'Leben in Deutschland — practice quiz',
      practice: 'Practice',
      exam: 'Exam',
      review: 'Review',
      progressTab: 'Progress',
      settingsTab: 'More',
      resetConfirm: 'Really reset?',
      allCategories: 'All categories',
      landOnly: (l) => l + ' only',
      landLabel: 'Federal state',
      answered: 'Answered',
      correctL: 'Correct',
      incorrectL: 'Incorrect',
      accuracy: 'Accuracy',
      questionN: (id) => 'Question ' + id,
      nextQuestion: 'Next question →',
      resetProgress: 'Reset progress',
      poolComplete: '🎉 Pool complete!',
      poolCompleteBody: (n) => 'You have answered all ' + n + ' questions in this selection.',
      startOver: 'Start over',
      remaining: (n) => n + ' unseen question' + (n === 1 ? '' : 's') + ' left',
      correctBang: '✓ Correct!',
      wrongAnswer: (l) => '✗ Wrong — correct answer: ' + l,
      showTranslation: 'Show translation',
      hideTranslation: 'Hide translation',
      explanation: 'Explanation',
      examTitle: 'Exam simulation',
      examIntro1: (g, b, l) => g + ' general questions + ' + b + ' questions about ' + l + '.',
      examIntro2: (p, t) => 'You pass with ' + p + ' or more correct answers out of ' + t + '.',
      startExam: 'Start exam',
      paperMode: '📄 Paper mode — like the real exam',
      paperNote: 'All 33 questions on one sheet, 60 minutes, graded only after you hand it in.',
      cancel: 'Cancel',
      unansweredWarn: (n) => n + ' questions still unanswered — tap again to submit anyway.',
      finishExam: 'Finish exam',
      questionOf: (i, n) => 'Question ' + i + ' of ' + n,
      correctSoFar: (n) => n + ' correct so far',
      passed: 'Passed!',
      failed: 'Not passed',
      score: (s, n) => s + ' / ' + n + ' correct',
      passNote: (p) => 'Pass threshold: ' + p + ' correct answers.',
      timeUsed: (s) => 'Time used: ' + s,
      timeUp: 'Time is up!',
      tryAgain: 'Try again',
      share: 'Share result',
      statsTitle: 'Community stats',
      examsL: 'Exams',
      passedL: 'Passed',
      hardestTitle: 'Most often answered incorrectly',
      mistakes: (n) => 'Your mistakes (' + n + ')',
      reviewCount: (n) => n + ' questions — correct answers highlighted',
      communityLine: (a, acc, e, p) => ['Community: ', a, ' answers, ', acc, '% correct · ', e, ' exams, ', p, ' passed'],
      settings: 'Settings',
      language: 'Language',
      theme: 'Theme',
      themeAuto: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      recentAttempts: 'Recent attempts',
      readiness: 'Pass probability today',
      readinessNote: 'Simulation of the real exam based on your progress.',
      drillCta: (n) => 'Drill weakest questions (' + n + ')',
      drillFilter: (n) => 'Focus drill (' + n + ')',
      drillDone: 'Drill cleared — nice work!',
      examDateLabel: 'Exam date',
      reminderLabel: 'Daily reminder',
      reminderOff: 'Off',
      soundLabel: 'Sound',
      soundOn: 'On',
      backupLabel: 'Progress',
      exportBtn: 'Back up',
      importBtn: 'Restore',
      coachLine: (d, q) => d + ' days left · target: ' + q + ' questions/day',
      onTrack: '✓ On track for today',
      behindBy: (n) => n + ' more today',
      searchPlaceholder: 'Search or question number…',
      mistakesFilter: (n) => 'My mistakes (' + n + ')',
      noMistakes: 'No mistakes saved — keep it up!',
      hardestFilter: (n) => 'Community stumbling blocks (' + n + ')',
      dueFilter: (n) => 'Due for review (' + n + ')',
      noDue: 'Nothing due for review — all fresh!',
      mastery: 'Progress by category',
      dailyLine: (s, c, g) => 'Streak: ' + s + ' 🔥 · Today: ' + c + '/' + g,
      readAloud: 'Read aloud',
      voiceMode: 'Voice mode',
      vListening: 'Listening…',
      vSpeaking: 'Reading…',
      voiceHint: 'Say A, B, C or D · "next" · "repeat"',
      supportLine: "Found this useful? The best thank-you is a donation to Ukraine's defenders —",
      supportFund: 'Sternenko Fund',
      chooseLand: 'Choose your federal state',
      chooseLandNote: 'The exam includes 3 questions about your federal state. You can change it later in settings.',
      noResults: 'No matches',
      installHint: 'Install this app: tap Share, then "Add to Home Screen"',
      updateReady: 'New version available',
      updateAction: 'Refresh',
      loadError: 'Could not load questions. Please reload the page.',
      loading: 'Loading questions…',
    },
    uk: {
      subtitle: 'Leben in Deutschland — тренувальний тест',
      practice: 'Практика',
      exam: 'Іспит',
      review: 'Огляд',
      progressTab: 'Прогрес',
      settingsTab: 'Більше',
      resetConfirm: 'Точно скинути?',
      allCategories: 'Усі категорії',
      landOnly: (l) => 'Лише ' + l,
      landLabel: 'Федеральна земля',
      answered: 'Відповіді',
      correctL: 'Правильно',
      incorrectL: 'Помилки',
      accuracy: 'Точність',
      questionN: (id) => 'Питання ' + id,
      nextQuestion: 'Наступне питання →',
      resetProgress: 'Скинути прогрес',
      poolComplete: '🎉 Усі питання пройдено!',
      poolCompleteBody: (n) => 'Ви відповіли на всі ' + n + ' питань цієї вибірки.',
      startOver: 'Почати заново',
      remaining: (n) => 'Залишилось питань: ' + n,
      correctBang: '✓ Правильно!',
      wrongAnswer: (l) => '✗ Неправильно — правильна відповідь: ' + l,
      showTranslation: 'Показати переклад',
      hideTranslation: 'Сховати переклад',
      explanation: 'Пояснення',
      examTitle: 'Симуляція іспиту',
      examIntro1: (g, b, l) => g + ' загальних питань + ' + b + ' питання про ' + l + '.',
      examIntro2: (p, t) => 'Іспит складено від ' + p + ' правильних відповідей із ' + t + '.',
      startExam: 'Почати іспит',
      paperMode: '📄 Паперовий режим — як справжній іспит',
      paperNote: 'Усі 33 питання на одному аркуші, 60 хвилин, результат лише після здачі.',
      cancel: 'Скасувати',
      unansweredWarn: (n) => 'Без відповіді: ' + n + ' — натисніть ще раз, щоб здати.',
      finishExam: 'Завершити іспит',
      questionOf: (i, n) => 'Питання ' + i + ' з ' + n,
      correctSoFar: (n) => 'Правильних поки що: ' + n,
      passed: 'Складено!',
      failed: 'Не складено',
      score: (s, n) => s + ' / ' + n + ' правильних',
      passNote: (p) => 'Прохідний бал: ' + p + ' правильних відповідей.',
      timeUsed: (s) => 'Витрачений час: ' + s,
      timeUp: 'Час вийшов!',
      tryAgain: 'Спробувати ще раз',
      share: 'Поділитися результатом',
      statsTitle: 'Статистика спільноти',
      examsL: 'Іспити',
      passedL: 'Складено',
      hardestTitle: 'Найчастіші помилки',
      mistakes: (n) => 'Ваші помилки (' + n + ')',
      reviewCount: (n) => 'Питань: ' + n + ' — правильні відповіді позначено',
      communityLine: (a, acc, e, p) => ['Спільнота: ', a, ' відповідей, ', acc, '% правильних · ', e, ' іспитів, ', p, ' складено'],
      settings: 'Налаштування',
      language: 'Мова',
      theme: 'Тема',
      themeAuto: 'Системна',
      themeLight: 'Світла',
      themeDark: 'Темна',
      recentAttempts: 'Останні спроби',
      readiness: 'Ймовірність скласти сьогодні',
      readinessNote: 'Симуляція справжнього іспиту на основі вашого прогресу.',
      drillCta: (n) => 'Тренувати найслабші (' + n + ')',
      drillFilter: (n) => 'Цільове тренування (' + n + ')',
      drillDone: 'Тренування завершено — молодець!',
      examDateLabel: 'Дата іспиту',
      reminderLabel: 'Щоденне нагадування',
      reminderOff: 'Вимк.',
      soundLabel: 'Звук',
      soundOn: 'Увімк.',
      backupLabel: 'Прогрес',
      exportBtn: 'Зберегти',
      importBtn: 'Відновити',
      coachLine: (d, q) => 'Залишилось днів: ' + d + ' · ціль: ' + q + ' питань/день',
      onTrack: '✓ Сьогодні за планом',
      behindBy: (n) => 'Ще ' + n + ' сьогодні',
      searchPlaceholder: 'Пошук або номер питання…',
      mistakesFilter: (n) => 'Мої помилки (' + n + ')',
      noMistakes: 'Помилок немає — так тримати!',
      hardestFilter: (n) => 'Найважчі для спільноти (' + n + ')',
      dueFilter: (n) => 'На повторення (' + n + ')',
      noDue: 'Нічого повторювати — все свіже!',
      mastery: 'Прогрес за категоріями',
      dailyLine: (s, c, g) => 'Серія: ' + s + ' 🔥 · Сьогодні: ' + c + '/' + g,
      readAloud: 'Озвучити',
      voiceMode: 'Голосовий режим',
      vListening: 'Слухаю…',
      vSpeaking: 'Читаю…',
      voiceHint: 'Скажіть A, B, C або D · «далі» · «повторити»',
      supportLine: 'Корисно? Найкраща подяка — донат на захисників України —',
      supportFund: 'Фонд Стерненка',
      chooseLand: 'Оберіть свою федеральну землю',
      chooseLandNote: 'На іспиті буде 3 питання про вашу федеральну землю. Змінити її можна в налаштуваннях.',
      noResults: 'Нічого не знайдено',
      installHint: 'Встановіть застосунок: натисніть «Поділитися», потім «На початковий екран»',
      updateReady: 'Доступна нова версія',
      updateAction: 'Оновити',
      loadError: 'Не вдалося завантажити питання. Оновіть сторінку.',
      loading: 'Завантаження питань…',
    },
  };

  const LOCALES = [['de', 'DE'], ['en', 'EN'], ['uk', 'УК']];

  function detectLocale() {
    const saved = localStorage.getItem('lang');
    if (saved && STRINGS[saved]) return saved;
    const nav = (navigator.language || 'de').slice(0, 2).toLowerCase();
    return STRINGS[nav] ? nav : 'en';
  }

  // The pool always scopes to the selected Bundesland: general questions plus
  // that state's ten. Other states' questions never surface.
  function filterPool(pool, category, deck, land, hardest) {
    let qs = pool.filter((q) => !q.land || q.land === land);
    if (category === 'land') qs = qs.filter((q) => q.land);
    else if (DECKS[category]) qs = qs.filter((q) => deck && deck.has(q.id));
    else if (category === 'hardest') qs = qs.filter((q) => hardest && hardest.has(q.id));
    else if (category !== 'all') qs = qs.filter((q) => q.category === category);
    return qs;
  }

  const WORD_RE = /([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*)/g;

  function QText({ q, vocab, locale, t }) {
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

  function QuestionCard({ q, selected, onSelect, t, locale, vocab }) {
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

  function Filters({ category, setCategory, categories, t, mistakesCount, dueCount, drillCount, land, hardestCount }) {
    return html`
      <div class="controls">
        <select class="select" value=${category} onChange=${(e) => setCategory(e.target.value)}>
          <option value="all">${t.allCategories}</option>
          ${categories.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}
          <option value="land">${t.landOnly(land)}</option>
          <option value="mistakes">${t.mistakesFilter(mistakesCount)}</option>
          <option value="due">${t.dueFilter(dueCount)}</option>
          ${drillCount > 0 && html`<option value="drill">${t.drillFilter(drillCount)}</option>`}
          ${hardestCount > 0 && html`<option value="hardest">${t.hardestFilter(hardestCount)}</option>`}
        </select>
      </div>`;
  }

  function Mastery({ rows, onPick, t }) {
    return html`
      <div class="mastery">
        <div class="m-label">${t.mastery}</div>
        ${rows.map((r) => html`
          <button key=${r.key} class="m-row" onClick=${() => onPick(r.key)}>
            <span class="m-name">${r.name}</span>
            <span class="m-count">${r.done}/${r.total}</span>
            <span class="m-bar"><span class=${r.done === r.total ? 'full' : ''} style=${{ width: (r.total ? (100 * r.done) / r.total : 0) + '%' }}></span></span>
          </button>`)}
      </div>`;
  }

  function Practice({ pool, categories, t, locale, land, hardest, vocab }) {
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

    // ---- Voice mode: speak the question, listen for an answer, speak the
    // verdict, listen for "next". The mic never runs while TTS is speaking.
    const [voiceMode, setVoiceMode] = useState(false);
    const [voiceState, setVoiceState] = useState('idle');
    const voiceRef = useRef(false);
    const recRef = useRef(null);

    const stopVoiceIO = () => {
      const rec = recRef.current;
      if (rec) {
        recRef.current = null;
        rec.onend = null;
        rec.onresult = null;
        try { rec.abort(); } catch (e) {}
      }
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    };

    useEffect(() => {
      voiceRef.current = voiceMode;
      if (!voiceMode) { stopVoiceIO(); setVoiceState('idle'); }
    }, [voiceMode]);

    useEffect(() => {
      if (!VOICE_OK || !voiceMode || !current) return undefined;
      let dead = false;

      const speakSeq = (parts, onDone) => {
        speechSynthesis.cancel();
        setVoiceState('speaking');
        parts.forEach((p, i) => {
          const u = new SpeechSynthesisUtterance(p.text);
          u.lang = p.lang;
          if (i === parts.length - 1) u.onend = () => { if (!dead) onDone(); };
          speechSynthesis.speak(u);
        });
      };

      const startListen = (onMatch) => {
        if (dead) return;
        let rec;
        try { rec = new SpeechRec(); } catch (e) { return; }
        rec.lang = SR_LANGS[locale];
        rec.interimResults = false;
        rec.maxAlternatives = 5;
        rec.onresult = (e) => {
          const res = e.results[e.results.length - 1];
          for (let i = 0; i < res.length; i++) {
            const m = matchVoice(res[i].transcript, locale);
            if (m) { onMatch(m); return; }
          }
        };
        // recognition times out after silence — keep it alive while waiting
        rec.onend = () => {
          if (!dead && voiceRef.current && !speechSynthesis.speaking) {
            try { rec.start(); } catch (e) {}
          }
        };
        rec.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setVoiceMode(false);
        };
        recRef.current = rec;
        setVoiceState('listening');
        try { rec.start(); } catch (e) {}
      };

      const run = () => {
        stopVoiceIO();
        if (selected == null) {
          const qText = current.question + '. ' +
            current.options.map((o, i) => LETTERS[i] + '. ' + o).join('. ');
          speakSeq([{ text: qText, lang: 'de-DE' }], () =>
            startListen((m) => {
              if (m.answer) answer(m.answer);
              else if (m.repeat) run();
            }));
        } else {
          const ok = selected === current.correct;
          const parts = [{
            text: (ok ? t.correctBang : t.wrongAnswer(LETTERS[current.correct - 1])).replace(/[✓✗]/g, ''),
            lang: SR_LANGS[locale],
          }];
          if (!ok) parts.push({ text: current.options[current.correct - 1], lang: 'de-DE' });
          const expl = current.expl && (current.expl[locale] || current.expl.de);
          if (expl) {
            parts.push({ text: expl, lang: current.expl[locale] ? SR_LANGS[locale] : 'de-DE' });
          }
          speakSeq(parts, () =>
            startListen((m) => {
              if (m.next) next();
              else if (m.repeat) run();
            }));
        }
      };

      run();
      return () => { dead = true; stopVoiceIO(); };
    }, [voiceMode, current, selected]);
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
          ${VOICE_OK && html`
            <button class=${'voicebtn iconly' + (voiceMode ? ' on' : '')} onClick=${() => setVoiceMode(!voiceMode)} aria-pressed=${voiceMode} aria-label=${t.voiceMode} title=${t.voiceMode}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
              </svg>
            </button>`}
        </div>
        ${VOICE_OK && voiceMode && html`
          <p class="voicehint">
            ${voiceState !== 'idle' && html`
              <span class="voicestatus">
                <span class=${'voicedot ' + voiceState}></span>
                ${voiceState === 'speaking' ? t.vSpeaking : t.vListening}
              </span>`}
            ${' '}${t.voiceHint}
          </p>`}

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

  const EXAM_GENERAL = 30, EXAM_LAND = 3, EXAM_PASS = 17, EXAM_MINUTES = 60;

  const LAND_CODES = {
    'Baden-Württemberg': 'BW', 'Bayern': 'BY', 'Berlin': 'BE', 'Brandenburg': 'BB',
    'Bremen': 'HB', 'Hamburg': 'HH', 'Hessen': 'HE', 'Mecklenburg-Vorpommern': 'MV',
    'Niedersachsen': 'NI', 'Nordrhein-Westfalen': 'NW', 'Rheinland-Pfalz': 'RP',
    'Saarland': 'SL', 'Sachsen': 'SN', 'Sachsen-Anhalt': 'ST',
    'Schleswig-Holstein': 'SH', 'Thüringen': 'TH',
  };

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

  function Exam({ pool, t, locale, land, vocab, community, onStartDrill }) {
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

  function Review({ pool, categories, t, locale, land, hardest, vocab }) {
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

  function Progress({ pool, categories, t, land, community, onOpenStats, onPickCategory }) {
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

  const CATEGORY_ORDER = [
    'Geschichte', 'Politik', 'Recht', 'Staat', 'Gesellschaft und Familie',
    'Europa und Welt', 'Bund und Länder', 'Religion und Kultur',
    'Bildung und Arbeit', 'Wirtschaft',
  ];

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

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
