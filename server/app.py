import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ebt")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "data" / "leben-in-deutschland-pool.json"
STATS_FILE = Path(os.environ.get("QUIZ_STATS_FILE", BASE_DIR / "data" / "stats.json"))
STATIC_DIR = BASE_DIR / "static"
IMG_DIR = STATIC_DIR / "img"

if os.environ.get("QUIZ_SECRET"):
    SECRET = os.environ["QUIZ_SECRET"]
else:
    SECRET = secrets.token_hex(32)
    log.warning(
        "QUIZ_SECRET not set — using a random secret generated at startup; "
        "every restart will invalidate all live tokens"
    )
TOKEN_TTL = 2 * 60 * 60
RATE_LIMIT = 120
RATE_WINDOW = 60

# Peers we trust to report a real client IP via X-Forwarded-For. Deliberately
# defaults to the private/loopback ranges: in production the immediate peer
# is always Caddy on a private Docker address, so XFF is trusted and we get
# the real client IP; a direct public connection has a public peer address,
# so XFF is ignored and we rate-limit the real peer instead. Defaulting to
# "trust nothing" would bucket ALL production traffic under Caddy's single
# peer IP and rate-limit the entire site at 120 req/min total — a
# self-inflicted outage — so that must NOT be done.
TRUSTED_PROXIES = [
    ipaddress.ip_network(net.strip(), strict=False)
    for net in os.environ.get(
        "TRUSTED_PROXIES",
        "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7",
    ).split(",")
    if net.strip()
]

with open(DATA_FILE, encoding="utf-8") as f:
    _raw_pool = json.load(f)

def _asset_exists(rec):
    return not rec["image"] or (IMG_DIR / rec.get("image_file", "")).is_file()

POOL = [r for r in _raw_pool if _asset_exists(r)]
VALID_IDS = {r["id"] for r in POOL}

I18N_FILE = BASE_DIR / "data" / "i18n-content.json"
try:
    with open(I18N_FILE, encoding="utf-8") as f:
        _i18n = {int(k): v for k, v in json.load(f).items()}
except FileNotFoundError:
    _i18n = {}
for _r in POOL:
    _extra = _i18n.get(_r["id"])
    if _extra:
        _r["trans"] = {"en": _extra["q_en"], "uk": _extra["q_uk"]}
        _r["expl"] = {"de": _extra["expl_de"], "en": _extra["expl_en"], "uk": _extra["expl_uk"]}

POOL_BYTES = json.dumps(POOL, ensure_ascii=False).encode()
POOL_ETAG = f'"{hashlib.sha256(POOL_BYTES).hexdigest()[:16]}"'


class Stats:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.data = {
            "answered": 0,
            "correct": 0,
            "exams_taken": 0,
            "exams_passed": 0,
            "per_question": {},
        }
        if path.is_file():
            try:
                self.data.update(json.loads(path.read_text()))
            except (json.JSONDecodeError, OSError):
                pass
        self._dirty = False

    def record_answer(self, qid: int, correct: bool):
        with self.lock:
            self.data["answered"] += 1
            self.data["correct"] += int(correct)
            pq = self.data["per_question"].setdefault(str(qid), [0, 0])
            pq[0] += 1
            pq[1] += int(correct)
            self._dirty = True

    def record_exam(self, passed: bool):
        with self.lock:
            self.data["exams_taken"] += 1
            self.data["exams_passed"] += int(passed)
            self._dirty = True

    def snapshot(self):
        with self.lock:
            d = self.data
            hardest = sorted(
                ((int(k), v[0], v[1]) for k, v in d["per_question"].items() if v[0] >= 5),
                key=lambda t: t[2] / t[1],
            )[:25]
            return {
                "answered": d["answered"],
                "correct": d["correct"],
                "accuracy": round(100 * d["correct"] / d["answered"], 1) if d["answered"] else None,
                "exams_taken": d["exams_taken"],
                "exams_passed": d["exams_passed"],
                "hardest": [
                    {"id": qid, "answered": n, "accuracy": round(100 * c / n, 1)}
                    for qid, n, c in hardest
                ],
                # per-question tallies with enough data to be a useful prior
                "pq": {k: v for k, v in d["per_question"].items() if v[0] >= 5},
            }

    def flush(self):
        with self.lock:
            if not self._dirty:
                return
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data))
            tmp.replace(self.path)
            self._dirty = False


STATS = Stats(STATS_FILE)

def _flusher():
    while True:
        time.sleep(15)
        try:
            STATS.flush()
        except Exception:
            # Broad on purpose: a single bad record (e.g. a TypeError from
            # json.dumps) must not silently kill this thread — that would
            # stop all stats persistence for the rest of the process lifetime.
            log.exception("stats flusher iteration failed")

threading.Thread(target=_flusher, daemon=True).start()


# ---- Web Push daily reminders ------------------------------------------------
PUSH_FILE = STATS_FILE.parent / "push.json"
VAPID_FILE = STATS_FILE.parent / "vapid.pem"

try:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid, b64urlencode
    from pywebpush import WebPushException, webpush

    if VAPID_FILE.is_file():
        _vapid = Vapid.from_file(str(VAPID_FILE))
    else:
        _vapid = Vapid()
        _vapid.generate_keys()
        _vapid.save_key(str(VAPID_FILE))
    VAPID_PUB = b64urlencode(
        _vapid.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    PUSH_OK = True
except Exception:  # missing deps or unwritable key path — run without push
    log.warning("push disabled: VAPID init failed", exc_info=True)
    PUSH_OK = False
    VAPID_PUB = None

PUSH_MESSAGES = {
    "de": {"title": "Zeit zum Üben! 🇩🇪", "body": "10 Fragen heute — halte deine Serie am Leben."},
    "en": {"title": "Time to practice! 🇩🇪", "body": "10 questions today — keep your streak alive."},
    "uk": {"title": "Час тренуватися! 🇩🇪", "body": "10 питань сьогодні — збережіть свою серію."},
}

_push_lock = threading.Lock()

def _push_load() -> dict:
    try:
        return json.loads(PUSH_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}

def _push_save(subs: dict):
    tmp = PUSH_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(subs))
    tmp.replace(PUSH_FILE)

def push_upsert(subscription: dict, utc_hour: int, lang: str):
    with _push_lock:
        subs = _push_load()
        subs[subscription["endpoint"]] = {
            "sub": subscription,
            "utcHour": utc_hour,
            "lang": lang if lang in PUSH_MESSAGES else "de",
            "lastSent": "",
        }
        _push_save(subs)

def push_remove(endpoint: str):
    with _push_lock:
        subs = _push_load()
        if subs.pop(endpoint, None) is not None:
            _push_save(subs)

def _push_sender():
    while True:
        time.sleep(300)
        try:
            now = time.gmtime()
            today = time.strftime("%Y-%m-%d", now)
            with _push_lock:
                subs = _push_load()
            dead, sent = [], []
            for endpoint, rec in subs.items():
                if rec["utcHour"] != now.tm_hour or rec.get("lastSent") == today:
                    continue
                msg = PUSH_MESSAGES[rec["lang"]]
                try:
                    webpush(
                        subscription_info=rec["sub"],
                        data=json.dumps(msg),
                        vapid_private_key=str(VAPID_FILE),
                        vapid_claims={"sub": "mailto:push@sarmatt.online"},
                    )
                    sent.append(endpoint)
                except WebPushException as e:
                    if e.response is not None and e.response.status_code in (400, 404, 410):
                        dead.append(endpoint)
                except Exception:
                    # One bad subscription must not abort the whole batch.
                    log.exception("push send failed for %s", endpoint)
            if dead or sent:
                with _push_lock:
                    subs = _push_load()
                    for ep in dead:
                        subs.pop(ep, None)
                    for ep in sent:
                        if ep in subs:
                            subs[ep]["lastSent"] = today
                    _push_save(subs)
        except Exception:
            # Keep the thread alive across a bad iteration.
            log.exception("push sender loop iteration failed")

if PUSH_OK:
    threading.Thread(target=_push_sender, daemon=True).start()


def make_token() -> str:
    ts = str(int(time.time()))
    sig = hmac.new(SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{ts}.{sig}"

def check_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    ts, sig = token.split(".", 1)
    if not ts.isdigit():
        return False
    expected = hmac.new(SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(sig, expected) and time.time() - int(ts) < TOKEN_TTL

_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = threading.Lock()

def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "?"
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        # Only honor XFF if the immediate peer is itself a trusted proxy —
        # otherwise a direct attacker fully controls the XFF header and can
        # rotate it per request to land in a fresh rate-limit bucket every
        # time, bypassing the limiter completely.
        try:
            peer_addr = ipaddress.ip_address(peer)
        except ValueError:
            # Unparseable peer (e.g. Starlette TestClient's "testclient")
            # is treated as untrusted.
            peer_addr = None
        if peer_addr is not None and any(peer_addr in net for net in TRUSTED_PROXIES):
            # The leftmost entry is client-supplied and trivially spoofable —
            # an attacker can rotate it per request to land in a fresh rate-limit
            # bucket every time. Caddy *appends* the real peer IP as the last
            # hop, so the rightmost entry is the one hop we actually trust.
            return fwd.split(",")[-1].strip()
    return peer

def rate_limit(request: Request):
    ip = client_ip(request)
    now = time.time()
    with _hits_lock:
        q = _hits[ip]
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            raise HTTPException(429, "Too many requests")
        q.append(now)
        if len(_hits) > 10000:
            for k in [k for k, v in _hits.items() if not v][:5000]:
                _hits.pop(k, None)

def require_token(request: Request):
    rate_limit(request)
    if not check_token(request.headers.get("x-quiz-token")):
        raise HTTPException(403, "Invalid or expired token")


# ---- Service worker version -------------------------------------------------
# The version embedded in sw.js used to be a manually bumped literal
# (`VERSION = 'v16'`) — forget the bump and clients serve stale JS forever.
# Instead we hash every asset the SW's SHELL array references at startup, so
# the cache name changes automatically whenever any shell asset changes.
SW_FILE = STATIC_DIR / "sw.js"
_SW_SOURCE = SW_FILE.read_text(encoding="utf-8")

_shell_match = re.search(r"const SHELL = \[(.*?)\];", _SW_SOURCE, re.S)
SW_SHELL = re.findall(r"'([^']+)'", _shell_match.group(1)) if _shell_match else []

def _sw_shell_path(rel: str) -> Path:
    return STATIC_DIR / "index.html" if rel == "/" else STATIC_DIR / rel.lstrip("/")

_shell_hash = hashlib.sha256()
for _rel in SW_SHELL:
    try:
        _shell_hash.update(_sw_shell_path(_rel).read_bytes())
    except OSError:
        log.error("SW shell asset missing or unreadable, skipping: %s", _rel)
SW_VERSION = _shell_hash.hexdigest()[:12]
SW_CONTENT = _SW_SOURCE.replace("__VERSION__", SW_VERSION)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Flush any stats accumulated since the last periodic flush so a deploy
    # restart never loses up to 15s of data. The flusher thread itself is
    # still started at import time (not here) so TestClient(app), which is
    # not used as a context manager, keeps working unaffected.
    STATS.flush()


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)

@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if "Cache-Control" not in response.headers:
        if path.startswith(("/vendor/", "/icons/", "/img/")):
            response.headers["Cache-Control"] = "public, max-age=604800"
        else:
            response.headers["Cache-Control"] = "no-cache"
    return response

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    return response

@app.get("/sw.js")
def get_sw():
    return Response(
        content=SW_CONTENT,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )

@app.get("/api/token")
def get_token(request: Request):
    rate_limit(request)
    if request.headers.get("x-requested-with") != "einbuergerungstest-quiz":
        raise HTTPException(403, "Forbidden")
    return {"token": make_token(), "ttl": TOKEN_TTL}

@app.get("/api/questions")
def get_questions(request: Request):
    require_token(request)
    headers = {"Cache-Control": "private, no-cache", "ETag": POOL_ETAG}
    if request.headers.get("if-none-match") == POOL_ETAG:
        return Response(status_code=304, headers=headers)
    return Response(content=POOL_BYTES, media_type="application/json", headers=headers)

class AnswerIn(BaseModel):
    id: int
    correct: bool

class ExamIn(BaseModel):
    passed: bool

@app.post("/api/stats/answer")
def post_answer(body: AnswerIn, request: Request):
    require_token(request)
    if body.id not in VALID_IDS:
        raise HTTPException(400, "Unknown question id")
    STATS.record_answer(body.id, body.correct)
    return {"ok": True}

@app.post("/api/stats/exam")
def post_exam(body: ExamIn, request: Request):
    require_token(request)
    STATS.record_exam(body.passed)
    return {"ok": True}

@app.get("/api/stats")
def get_stats(request: Request):
    rate_limit(request)
    return STATS.snapshot()

@app.get("/api/push/key")
def push_key(request: Request):
    rate_limit(request)
    if not PUSH_OK:
        raise HTTPException(503, "Push unavailable")
    return {"key": VAPID_PUB}

class PushSubIn(BaseModel):
    subscription: dict
    utcHour: int
    lang: str = "de"

class PushUnsubIn(BaseModel):
    endpoint: str

@app.post("/api/push/subscribe")
def push_subscribe(body: PushSubIn, request: Request):
    require_token(request)
    if not PUSH_OK:
        raise HTTPException(503, "Push unavailable")
    endpoint = body.subscription.get("endpoint", "")
    if not (0 <= body.utcHour <= 23) or not endpoint.startswith("https://"):
        raise HTTPException(400, "Invalid subscription")
    push_upsert(body.subscription, body.utcHour, body.lang)
    return {"ok": True}

@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushUnsubIn, request: Request):
    require_token(request)
    push_remove(body.endpoint)
    return {"ok": True}

@app.get("/healthz")
def healthz():
    return {"ok": True, "questions": len(POOL)}

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
