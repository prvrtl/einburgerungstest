let _token = null;

export async function getToken() {
  if (_token) return _token;
  const res = await fetch('/api/token', {
    headers: { 'X-Requested-With': 'einbuergerungstest-quiz' },
  });
  if (!res.ok) throw new Error('token ' + res.status);
  _token = (await res.json()).token;
  return _token;
}

export async function api(path, opts = {}, retry = true) {
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

export const reportAnswer = (id, correct) =>
  api('/api/stats/answer', { method: 'POST', body: JSON.stringify({ id, correct }) }).catch(() => {});
export const reportExam = (passed) =>
  api('/api/stats/exam', { method: 'POST', body: JSON.stringify({ passed }) }).catch(() => {});
