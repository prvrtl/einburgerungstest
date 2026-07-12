# Einbürgerungstest Trainer

Practice quiz web app for the German "Leben in Deutschland" / Einbürgerungstest
(300 general questions + 10 for Berlin), served at
https://einburgerungstest.sarmatt.online.

## Stack

- Backend: Python 3.13, FastAPI, entry point `server/app.py` (uvicorn app `server.app:app`).
- Frontend: React via vendored UMD build + htm, no build step — plain files in `static/`.
- Data: `data/leben-in-deutschland-pool.json` (question pool), `data/i18n-content.json`.

## Key directories

- `server/` — FastAPI backend (token gate, stats endpoints).
- `static/` — frontend (`index.html`, `js/` ES modules, `styles.css`, `vendor/`, service worker `sw.js`).
- `tests/` — pytest + Playwright e2e tests.
- `data/` — question pool, i18n content, VAPID key.

## Commands

- Dev server: `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`
  then `QUIZ_SECRET=dev .venv/bin/uvicorn server.app:app --port 8300 --reload`
- Test: `.venv/bin/pytest -q`
- Docker: `docker compose up --build`, open http://127.0.0.1:8300
- Deploy: `./deploy.sh` (pulls prebuilt GHCR image, restarts stack, smoke-tests
  the public URL). Run via CI on push to main, or manually on the droplet.
- No lint command defined.

## Conventions

- No frontend build step by design (vendored UMD React + htm).
- Deployed co-hosted with "mastobot" on the same droplet, sharing an external
  `edge` Docker network; this app's container publishes no ports directly.
- `static/sw.js` ships with `VERSION = '__VERSION__'` as a literal placeholder.
  `server/app.py` serves `/sw.js` itself (not via the static mount) and
  substitutes it at startup with a hash of every asset in the SW's `SHELL`
  array. The cache version is therefore derived automatically whenever any
  shell asset changes — there is no manual version bump to remember anymore.
