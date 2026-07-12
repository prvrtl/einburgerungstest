export const store = {
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

// Everything the app remembers about a user, for backup/restore.
export const PROGRESS_KEYS = [
  'practice.seen', 'practice.counters', 'practice.category', 'mistakes',
  'qstate', 'srs', 'daily', 'examHistory', 'readiness.history', 'drill',
  'examDate', 'land', 'lang', 'theme', 'sound', 'reminder',
];

export const exportProgress = () => {
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

export const importProgress = (file) => {
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
