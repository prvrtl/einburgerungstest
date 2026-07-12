# Einbürgerungstest Trainer

Practice quiz for the German "Leben in Deutschland" / Einbürgerungstest (300 general
questions + 10 for Berlin), running at https://einburgerungstest.sarmatt.online.

FastAPI backend serves the question pool and global stats. Frontend is React (vendored
UMD build + htm, no build step): practice mode, exam simulation, review mode, category
filter, text-only toggle.

## Development

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
QUIZ_SECRET=dev .venv/bin/uvicorn server.app:app --port 8300 --reload
```

Tests: `.venv/bin/pytest -q`

Or with docker: `docker compose up --build` and open http://127.0.0.1:8300.

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/token` | custom header | signed 2h token |
| `GET /api/questions` | `X-Quiz-Token` | question pool |
| `POST /api/stats/answer` | `X-Quiz-Token` | record an answer |
| `POST /api/stats/exam` | `X-Quiz-Token` | record an exam result |
| `GET /api/stats` | none | global counters |
| `GET /healthz` | none | liveness |

The token gate and per-IP rate limiting keep casual scrapers out. Stats go to
`stats.json` (in docker: the `stats` volume, via `QUIZ_STATS_FILE`).

## Deployment

Co-hosted with mastobot on the same droplet. This stack publishes no ports; mastobot's
Caddy terminates TLS and proxies to the container over the shared external `edge`
network. Mastobot's `.env.local` sets `CADDY_EXTRA_CONFIG=import /config/*.caddy`, and
the vhost lives in the `app_caddy_config` volume as `einburgerungstest.caddy`:

```
einburgerungstest.sarmatt.online {
	reverse_proxy einburgerungstest:8300
}
```

(A one-line site block inside the env var itself does not work — Caddyfile requires the
opening brace to end its line.)

Push to main runs pytest, builds `ghcr.io/prvrtl/einburgerungstest`, and SSHes to the
droplet to run `deploy.sh` (pull, restart, smoke test against the public URL).

Repo settings needed: variables `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, optional
`DEPLOY_PORT`; secrets `DEPLOY_SSH_KEY`, `GHCR_PAT`.

One-time host setup:

```sh
docker network create edge
git clone git@github.com:prvrtl/einburgerungstest.git /opt/einburgerungstest
cd /opt/einburgerungstest
echo "QUIZ_SECRET=$(openssl rand -hex 32)" > .env.local
./deploy.sh
```

## Attribution

Data based on the official BAMF "Gesamtfragenkatalog Leben in Deutschland /
Einbürgerungstest, Stand 07.05.2025". Question set and images from the MIT-licensed
project [flexsurfer/einburgerungstest](https://github.com/flexsurfer/einburgerungstest).
Not endorsed by or affiliated with the BAMF. Answers are community-sourced and intended
for practice only.
