import { store } from './store.js';
import { EXAM_GENERAL, EXAM_LAND, EXAM_PASS } from './util.js';

// ---- Readiness engine: estimate P(correct) per question, then Monte-Carlo
// simulate the real exam draw (30 general + 3 state, pass at 17).
// Calibrated guesses per Leitner box when the last answer was correct.
export const BOX_P = [0.6, 0.65, 0.75, 0.85, 0.9, 0.95];
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

export function simulateReadiness(pool, land, community) {
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
