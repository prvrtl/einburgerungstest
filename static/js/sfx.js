import { store } from './store.js';

// ---- 8-bit sound effects: square-wave chiptunes synthesized on the fly.
let _actx = null;
export const soundOn = () => store.read('sound', true);

export function playNotes(notes) {
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

export const SFX = {
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
