import { DECKS } from './srs.js';

export const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
export const sample = (arr, n) => shuffle(arr).slice(0, n);
export const LETTERS = ['A', 'B', 'C', 'D'];

// The pool always scopes to the selected Bundesland: general questions plus
// that state's ten. Other states' questions never surface.
export function filterPool(pool, category, deck, land, hardest) {
  let qs = pool.filter((q) => !q.land || q.land === land);
  if (category === 'land') qs = qs.filter((q) => q.land);
  else if (DECKS[category]) qs = qs.filter((q) => deck && deck.has(q.id));
  else if (category === 'hardest') qs = qs.filter((q) => hardest && hardest.has(q.id));
  else if (category !== 'all') qs = qs.filter((q) => q.category === category);
  return qs;
}

export const EXAM_GENERAL = 30, EXAM_LAND = 3, EXAM_PASS = 17, EXAM_MINUTES = 60;

export const LAND_CODES = {
  'Baden-Württemberg': 'BW', 'Bayern': 'BY', 'Berlin': 'BE', 'Brandenburg': 'BB',
  'Bremen': 'HB', 'Hamburg': 'HH', 'Hessen': 'HE', 'Mecklenburg-Vorpommern': 'MV',
  'Niedersachsen': 'NI', 'Nordrhein-Westfalen': 'NW', 'Rheinland-Pfalz': 'RP',
  'Saarland': 'SL', 'Sachsen': 'SN', 'Sachsen-Anhalt': 'ST',
  'Schleswig-Holstein': 'SH', 'Thüringen': 'TH',
};

// Practice/Review/Progress share this category order (matches the BAMF
// catalogue's official grouping).
export const CATEGORY_ORDER = [
  'Geschichte', 'Politik', 'Recht', 'Staat', 'Gesellschaft und Familie',
  'Europa und Welt', 'Bund und Länder', 'Religion und Kultur',
  'Bildung und Arbeit', 'Wirtschaft',
];
