"""Browser-level smoke test: load → practice → exam → result → persistence.

Catches the class of frontend breakage the API tests can't see (JS errors,
stale/incomplete pool payloads, broken rendering). Skipped automatically when
playwright is not installed.
"""

import threading
import time

import pytest

playwright_sync = pytest.importorskip("playwright.sync_api")

import uvicorn

from server.app import app

PORT = 8399
BASE_URL = f"http://127.0.0.1:{PORT}"


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


def test_full_user_flow(server):
    with playwright_sync.sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        js_errors = []
        page.on("pageerror", lambda err: js_errors.append(str(err)))
        page.add_init_script("localStorage.setItem('lang', 'de')")

        # First launch: the Bundesland prompt appears; pick Berlin
        page.goto(BASE_URL)
        page.get_by_role("button", name="Berlin", exact=True).click()

        # Practice: question renders, answering shows verdict + explanation
        page.wait_for_selector(".qtext")
        page.locator(".opt").first.click()
        page.wait_for_selector(".verdict")
        page.wait_for_selector(".expl")
        page.locator(".actionsbar .btn").click()
        # .qtext persists across questions — wait for the verdict to detach so
        # the next question is actually active before typing
        page.wait_for_selector(".verdict", state="detached")
        page.wait_for_selector(".qtext")

        # Keyboard answering: press "a" to answer, Enter for next question
        page.keyboard.press("a")
        page.wait_for_selector(".verdict")
        page.keyboard.press("Enter")
        page.wait_for_selector(".verdict", state="detached")
        page.wait_for_selector(".qtext")

        # Voice mode toggles on and off without page errors (no mic in CI —
        # the state machine must still not crash)
        if page.locator(".voicebtn").count():
            page.locator(".voicebtn").click()
            page.wait_for_timeout(500)
            page.locator(".voicebtn").click()
            page.wait_for_selector(".qtext")

        # Exam: full run through all 33 questions to the result screen
        page.locator(".tab", has_text="Prüfung").click()
        page.get_by_role("button", name="Prüfung starten").click()
        for _ in range(33):
            page.wait_for_selector(".opt:not([disabled])")
            page.locator(".opt").first.click()
            page.wait_for_selector(".verdict")
            page.locator(".actions .btn").click()
        page.wait_for_selector(".result .score")

        # Progress survives a reload
        page.reload()
        page.wait_for_selector(".qtext")
        answered = page.evaluate(
            "JSON.parse(localStorage.getItem('practice.counters')).answered"
        )
        assert answered >= 1

        assert js_errors == [], f"JS errors on page: {js_errors}"
        browser.close()
