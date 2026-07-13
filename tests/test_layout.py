"""No-scroll layout audit.

The app-frame invariant: the page itself never scrolls, and every piece of
content is either visible in the viewport or inside a designated scrollable
pane (reachable by scrolling that pane). Checked at three phone sizes across
every screen and state.
"""

import threading
import time

import pytest

playwright_sync = pytest.importorskip("playwright.sync_api")

import uvicorn

from server.app import app

PORT = 8398
BASE_URL = f"http://127.0.0.1:{PORT}"

VIEWPORTS = [(320, 568), (390, 844), (430, 932)]

# JS: element is accounted for if it intersects the viewport OR lives inside
# a scrollable ancestor (so scrolling that pane reveals it).
REACHABLE_JS = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return 'missing';
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  if (visible) return 'ok';
  for (let n = el.parentElement; n; n = n.parentElement) {
    const st = getComputedStyle(n);
    if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && n.scrollHeight > n.clientHeight) {
      return 'ok';
    }
  }
  return 'clipped';
}"""

NO_PAGE_SCROLL_JS = """() => {
  const d = document.scrollingElement;
  return { sh: d.scrollHeight, ch: window.innerHeight };
}"""


@pytest.fixture(scope="module")
def server():
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
    srv = uvicorn.Server(config)
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.1)
    else:
        pytest.fail("uvicorn did not start")
    yield
    srv.should_exit = True
    thread.join(timeout=5)


def assert_no_page_scroll(page, where):
    m = page.evaluate(NO_PAGE_SCROLL_JS)
    assert m["sh"] <= m["ch"] + 1, f"page scrolls on {where}: {m}"


def assert_reachable(page, selectors, where):
    for sel in selectors:
        verdict = page.evaluate(REACHABLE_JS, sel)
        assert verdict == "ok", f"{sel} is {verdict} on {where}"


def test_layout_audit(server):
    with playwright_sync.sync_playwright() as p:
        browser = p.chromium.launch()
        for w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme="dark")
            page = ctx.new_page()
            page.add_init_script(
                "localStorage.setItem('lang','de');"
                "localStorage.setItem('land', JSON.stringify('Berlin'));"
                "localStorage.setItem('examHistory', JSON.stringify([{d:1,s:20,n:33}]));"
            )
            where = f"{w}x{h}"
            page.goto(BASE_URL + "/app")
            page.wait_for_selector(".qtext")

            # tab bar itself
            assert_reachable(page, [".tabbar", ".tab"], f"practice {where}")

            # practice: unanswered
            assert_no_page_scroll(page, f"practice {where}")
            assert_reachable(page, [".select", ".qtext", ".opt", ".chips"], f"practice {where}")

            # practice: answered (verdict + explanation)
            page.locator(".opt").first.click()
            page.wait_for_selector(".expl")
            assert_no_page_scroll(page, f"practice-answered {where}")
            assert_reachable(page, [".verdict", ".expl", ".actionsbar .btn"], f"practice-answered {where}")

            # exam intro
            page.locator(".tab", has_text="Prüfung").click()
            page.wait_for_selector(".ready-num")
            assert_no_page_scroll(page, f"exam-intro {where}")
            assert_reachable(
                page,
                [".ready-num", ".coach-date", ".exam-history", ".btn", ".btn.ghost"],
                f"exam-intro {where}",
            )

            # exam running
            page.get_by_role("button", name="Prüfung starten").click()
            page.wait_for_selector(".exam-timer")
            assert_no_page_scroll(page, f"exam-running {where}")
            assert_reachable(page, [".exam-timer", ".qtext", ".opt"], f"exam-running {where}")

            # review
            page.locator(".tab", has_text="Übersicht").click()
            page.wait_for_selector(".review-item")
            assert_no_page_scroll(page, f"review {where}")
            assert_reachable(page, [".search", ".review-item"], f"review {where}")

            # progress
            page.locator(".tab", has_text="Fortschritt").click()
            page.wait_for_selector(".m-row")
            assert_no_page_scroll(page, f"progress {where}")
            assert_reachable(
                page,
                [".brand", ".daily", ".stat", ".m-row", ".exam-history", ".support"],
                f"progress {where}",
            )

            # settings sheet (with About/legal)
            page.locator(".tab", has_text="Mehr").click()
            page.wait_for_selector(".sheet")
            assert_no_page_scroll(page, f"settings {where}")
            assert_reachable(page, [".setting-row", ".about", ".backup-btns"], f"settings {where}")

            ctx.close()
        browser.close()
