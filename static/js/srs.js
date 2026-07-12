import { store } from './store.js';

export const readMistakes = () => new Set(store.read('mistakes', []));

// Leitner boxes: wrong answers land in box 1, each correct answer moves the
// question up a box. A question is due again after SRS_DAYS[box] days.
export const SRS_DAYS = [0, 0, 1, 3, 7, 30];

export const readDue = () => {
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
export const DECKS = {
  mistakes: readMistakes,
  due: readDue,
  drill: () => new Set(store.read('drill', [])),
};

export const DAILY_GOAL = 10;
export const localDay = (offsetMs = 0) => new Date(Date.now() - offsetMs).toLocaleDateString('sv');

// One entry point for "the user answered question id": feeds the mistakes
// deck, per-question mastery state, and the daily streak counter.
export const recordResult = (id, correct) => {
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

export const readStreak = () => {
  const d = store.read('daily', { date: '', count: 0, streak: 0, lastGoal: '' });
  const today = localDay();
  return {
    count: d.date === today ? d.count : 0,
    streak: d.lastGoal === today || d.lastGoal === localDay(864e5) ? d.streak : 0,
  };
};
