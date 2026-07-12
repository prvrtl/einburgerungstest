import hashlib
import hmac
import re
import time
from collections import Counter

import pytest
from fastapi.testclient import TestClient

from server import app as appmod
from server.app import IMG_DIR, app

client = TestClient(app)

TOKEN_HEADER = {"X-Requested-With": "einbuergerungstest-quiz"}


def fresh_token() -> str:
    return client.get("/api/token", headers=TOKEN_HEADER).json()["token"]


def auth(token=None):
    return {"X-Quiz-Token": token or fresh_token()}


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "questions": 459}


def test_token_requires_js_header():
    assert client.get("/api/token").status_code == 403
    r = client.get("/api/token", headers=TOKEN_HEADER)
    assert r.status_code == 200
    assert "." in r.json()["token"]


def test_questions_rejects_missing_and_forged_tokens():
    assert client.get("/api/questions").status_code == 403
    assert client.get("/api/questions", headers=auth("1234.deadbeef")).status_code == 403


def test_questions_rejects_expired_token():
    ts = str(int(time.time()) - appmod.TOKEN_TTL - 1)
    sig = hmac.new(appmod.SECRET.encode(), ts.encode(), hashlib.sha256).hexdigest()[:32]
    assert client.get("/api/questions", headers=auth(f"{ts}.{sig}")).status_code == 403


def test_pool_contents():
    pool = client.get("/api/questions", headers=auth()).json()
    assert len(pool) == 459
    ids = {q["id"] for q in pool}
    assert 209 not in ids
    assert len(ids) == 459
    for q in pool:
        assert len(q["options"]) == 4
        assert 1 <= q["correct"] <= 4
        assert q["question"]
        if q["image"]:
            assert (IMG_DIR / q["image_file"]).is_file()

    counts = Counter(q["category"] for q in pool)
    assert counts["Berlin"] == 10
    assert counts["Geschichte"] == 69
    assert counts["Politik"] == 57


def test_land_questions():
    pool = client.get("/api/questions", headers=auth()).json()
    lands = {}
    for q in pool:
        if q.get("land"):
            lands.setdefault(q["land"], []).append(q)
    assert len(lands) == 16
    for land, qs in lands.items():
        assert len(qs) == 10, land
        assert sorted(x["num"] for x in qs) == list(range(301, 311)), land
        assert sum(1 for x in qs if x["image"]) == 2, land
        assert all(x["category"] == land for x in qs)
    # Berlin keeps its historical ids; other states use the unique 311+ range
    assert sorted(q["id"] for q in lands["Berlin"]) == list(range(301, 311))
    other_ids = [q["id"] for l, qs in lands.items() if l != "Berlin" for q in qs]
    assert min(other_ids) == 311 and max(other_ids) == 460


def test_category_totals_add_up():
    pool = client.get("/api/questions", headers=auth()).json()
    general = [q for q in pool if q["id"] <= 300]
    assert len(general) == 299


def test_stats_flow():
    headers = auth()
    before = client.get("/api/stats").json()

    r = client.post("/api/stats/answer", json={"id": 1, "correct": True}, headers=headers)
    assert r.status_code == 200
    r = client.post("/api/stats/answer", json={"id": 2, "correct": False}, headers=headers)
    assert r.status_code == 200
    r = client.post("/api/stats/exam", json={"passed": True}, headers=headers)
    assert r.status_code == 200

    after = client.get("/api/stats").json()
    assert after["answered"] == before["answered"] + 2
    assert after["correct"] == before["correct"] + 1
    assert after["exams_taken"] == before["exams_taken"] + 1
    assert after["exams_passed"] == before["exams_passed"] + 1
    assert isinstance(after["pq"], dict)
    for tally in after["pq"].values():
        assert tally[0] >= 5 and tally[1] <= tally[0]


def test_stats_rejects_unknown_question_and_bad_payload():
    headers = auth()
    assert client.post("/api/stats/answer", json={"id": 209, "correct": True}, headers=headers).status_code == 400
    assert client.post("/api/stats/answer", json={"id": 99999, "correct": True}, headers=headers).status_code == 400
    assert client.post("/api/stats/answer", json={"correct": True}, headers=headers).status_code == 422
    assert client.post("/api/stats/answer", json={"id": 1, "correct": True}).status_code == 403


def test_stats_persist_to_disk():
    appmod.STATS.flush()
    assert appmod.STATS.path.is_file()


def test_push_endpoints():
    r = client.get("/api/push/key")
    if r.status_code == 503:
        pytest.skip("push dependencies unavailable")
    assert r.status_code == 200
    assert len(r.json()["key"]) > 40

    headers = auth()
    sub = {"endpoint": "https://push.example/ep1", "keys": {"p256dh": "x", "auth": "y"}}
    ok = client.post(
        "/api/push/subscribe",
        json={"subscription": sub, "utcHour": 18, "lang": "de"},
        headers=headers,
    )
    assert ok.status_code == 200
    bad_hour = client.post(
        "/api/push/subscribe",
        json={"subscription": sub, "utcHour": 25, "lang": "de"},
        headers=headers,
    )
    assert bad_hour.status_code == 400
    insecure = client.post(
        "/api/push/subscribe",
        json={"subscription": {"endpoint": "http://plain"}, "utcHour": 8, "lang": "de"},
        headers=headers,
    )
    assert insecure.status_code == 400
    assert client.post("/api/push/subscribe", json={"subscription": sub, "utcHour": 8}).status_code == 403
    gone = client.post("/api/push/unsubscribe", json={"endpoint": sub["endpoint"]}, headers=headers)
    assert gone.status_code == 200


def test_static_frontend_served():
    assert client.get("/").status_code == 200
    assert "Einbürgerungstest" in client.get("/").text
    assert client.get("/js/main.js").status_code == 200
    assert client.get("/img/aufgabe_21.png").status_code == 200


def test_seo_assets():
    robots = client.get("/robots.txt")
    assert robots.status_code == 200
    assert "Sitemap:" in robots.text
    sitemap = client.get("/sitemap.xml")
    assert sitemap.status_code == 200
    assert "einburgerungstest.sarmatt.online" in sitemap.text
    index = client.get("/").text
    assert 'property="og:title"' in index
    assert 'rel="canonical"' in index


def test_vocab_served():
    r = client.get("/vocab.json")
    assert r.status_code == 200
    vocab = r.json()
    assert len(vocab) >= 60
    for entry in vocab:
        assert entry["de"].strip() and entry["en"].strip() and entry["uk"].strip()


def test_pwa_assets_served():
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert client.get("/sw.js").status_code == 200
    for icon in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"):
        assert client.get(f"/icons/{icon}").status_code == 200
    index = client.get("/").text
    assert "manifest.webmanifest" in index
    assert "apple-touch-icon" in index
    assert "boot.js" in index
    assert "serviceWorker" in client.get("/js/boot.js").text


def test_i18n_content_complete():
    pool = client.get("/api/questions", headers=auth()).json()
    for q in pool:
        assert "trans" in q, f"missing translations for id {q['id']}"
        assert q["trans"]["en"].strip() and q["trans"]["uk"].strip()
        assert "expl" in q, f"missing explanations for id {q['id']}"
        for lang in ("de", "en", "uk"):
            assert q["expl"][lang].strip(), f"empty {lang} explanation for id {q['id']}"


def test_cache_headers():
    assert client.get("/icons/icon-192.png").headers["cache-control"] == "public, max-age=604800"
    assert client.get("/js/main.js").headers["cache-control"] == "no-cache"
    cc = client.get("/api/questions", headers=auth()).headers["cache-control"]
    assert "no-cache" in cc and "private" in cc


def test_questions_etag_revalidation():
    headers = auth()
    r = client.get("/api/questions", headers=headers)
    etag = r.headers["etag"]
    assert etag
    r304 = client.get("/api/questions", headers={**headers, "If-None-Match": etag})
    assert r304.status_code == 304
    assert not r304.content
    r200 = client.get("/api/questions", headers={**headers, "If-None-Match": '"stale"'})
    assert r200.status_code == 200


@pytest.mark.parametrize("qid,expected_correct", [(1, 4), (21, 1)])
def test_known_answers_spot_check(qid, expected_correct):
    pool = client.get("/api/questions", headers=auth()).json()
    q = next(q for q in pool if q["id"] == qid)
    assert q["correct"] == expected_correct


def test_security_headers_present():
    for r in (client.get("/"), client.get("/api/stats")):
        csp = r.headers["content-security-policy"]
        assert "frame-ancestors 'none'" in csp
        assert "unsafe-inline" not in csp.split("script-src", 1)[1].split(";", 1)[0]
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
        assert r.headers["x-frame-options"] == "DENY"
        assert r.headers["permissions-policy"] == "geolocation=(), camera=(), microphone=()"


def test_sw_js_version_substitution():
    r = client.get("/sw.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/javascript")
    assert "__VERSION__" not in r.text
    match = re.search(r"const VERSION = '([0-9a-f]+)'", r.text)
    assert match and match.group(1)


def test_sw_shell_assets_exist_on_disk():
    assert appmod.SW_SHELL, "SHELL array should not be empty"
    for rel in appmod.SW_SHELL:
        path = appmod.STATIC_DIR / "index.html" if rel == "/" else appmod.STATIC_DIR / rel.lstrip("/")
        assert path.is_file(), f"SHELL asset missing on disk: {rel}"


def test_spoofed_xff_ignored_for_untrusted_peer():
    # TestClient's default peer is the literal "testclient", which is not a
    # parseable/trusted IP, so XFF must be ignored entirely and every
    # request buckets under the peer regardless of the (fully
    # attacker-controlled) X-Forwarded-For value.
    appmod._hits.clear()
    try:
        for i in range(appmod.RATE_LIMIT):
            r = client.get(
                "/api/stats",
                headers={"X-Forwarded-For": f"203.0.113.{i}"},
            )
            assert r.status_code == 200
        r = client.get(
            "/api/stats",
            headers={"X-Forwarded-For": "203.0.113.254"},
        )
        assert r.status_code == 429
    finally:
        appmod._hits.clear()


def test_xff_trusted_when_peer_is_trusted_proxy():
    # A peer within TRUSTED_PROXIES' default private ranges is trusted, so
    # the rightmost XFF hop is used for bucketing — not the leftmost.
    trusted_client = TestClient(app, client=("10.1.2.3", 1234))
    appmod._hits.clear()
    try:
        for _ in range(appmod.RATE_LIMIT):
            r = trusted_client.get(
                "/api/stats",
                headers={"X-Forwarded-For": "1.2.3.4, 55.55.55.55"},
            )
            assert r.status_code == 200
        r = trusted_client.get(
            "/api/stats",
            headers={"X-Forwarded-For": "1.2.3.4, 55.55.55.55"},
        )
        assert r.status_code == 429

        appmod._hits.clear()
        for i in range(appmod.RATE_LIMIT):
            r = trusted_client.get(
                "/api/stats",
                headers={"X-Forwarded-For": f"9.9.9.{i}, 55.55.55.55"},
            )
            assert r.status_code == 200
        r = trusted_client.get(
            "/api/stats",
            headers={"X-Forwarded-For": "9.9.9.254, 55.55.55.55"},
        )
        assert r.status_code == 429
    finally:
        appmod._hits.clear()
