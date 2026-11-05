#!/usr/bin/python3
"""Watch NYRR's 2026 volunteer events for +1 shifts that reopen, and send a phone alert.

NYRR has no volunteer wait list: cancelled spots go straight back on the site, so the alert has to
beat other people to them. Run by GitHub Actions (.github/workflows/watch.yml), which sets NTFY_TOPIC
so alerts go to phones through ntfy. The Cloudflare worker in worker/ does the same check every
minute and starts this one only when it can't read NYRR.
No login, never registers. --test sends one test alert.
"""
import datetime
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")
LOG = os.path.join(HERE, "watch.log")
COOKIES = os.path.join(HERE, "cookies.txt")
# Only the Ted Corbitt 15K (Dec 5): the other three are entered as races, and NYRR
# won't let a runner volunteer at a race they're entered in.
EVENTS = [
    "https://www.nyrr.org/races-and-events/2026/nyrr-ted-corbitt-15k-volunteers",
]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
BLIND_AFTER = 3  # failed runs in a row before warning that the watcher can't see the site
SUMMARY_HOUR = 8  # local hour of the once-a-day "still watching" notification


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M} {msg}\n")


def notify(title, body, url=None, priority="default"):
    topic = os.environ.get("NTFY_TOPIC")
    if topic:
        # ntfy phone push; tapping it opens url.
        headers = ["-H", f"Title: {title}", "-H", f"Priority: {priority}"] + (["-H", f"Click: {url}"] if url else [])
        r = subprocess.run(["curl", "-sf", "-o", "/dev/null", "--max-time", "20", "--retry", "2", *headers, "-d", body, f"https://ntfy.sh/{topic}"], check=False)
        return r.returncode == 0
    if shutil.which("osascript"):
        script = f'display notification {json.dumps(body)} with title {json.dumps(title)} sound name "Glass"'
        return subprocess.run(["osascript", "-e", script], check=False).returncode == 0
    print(f"NOTIFY {title}: {body}")
    return True


def fetch(url):
    # -L and the cookie jar get through NYRR's Queue-it redirect when no queue is running.
    r = subprocess.run(
        ["curl", "-sL", "--max-redirs", "8", "--max-time", "40", "-c", COOKIES, "-b", COOKIES, "-A", UA, url],
        capture_output=True, text=True, errors="replace",
    )
    return r.stdout if r.returncode == 0 else ""


def shifts(page_html):
    """Every registration option on an event page as (id, name, status, has_plus_one, register_link)."""
    found = []
    for chunk in page_html.split('data-registration-option-id="')[1:]:
        chunk = chunk.split("</article>")[0]
        status = re.search(r'data-event-status="([^"]+)"', chunk)
        name = re.search(r"<h3[^>]*><span>(.*?)</span>", chunk, re.S)
        if status and name:
            plus_one = re.search(r"<li><span[^>]*>9\+1</span></li>", chunk) is not None
            # Only bookable options carry a Register link; sold-out, closed and completed ones don't.
            link = re.search(r'href="(https://register\.nyrr\.org/[^"]+)"', chunk)
            register_link = html.unescape(link.group(1)) if link else None
            found.append((chunk.split('"')[0], html.unescape(name.group(1)).strip(), status.group(1), plus_one, register_link))
    return found


def event_name(page_html, url):
    title = re.search(r"<title>(.*?)</title>", page_html, re.S)
    name = html.unescape(title.group(1)).strip() if title else url.rsplit("/", 1)[-1]
    return re.sub(r"\s*-\s*Volunteers?$", "", name)


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"open": [], "fails": 0, "summary_day": ""}


def main():
    if "--test" in sys.argv:
        sys.exit(0 if notify("TEST: NYRR watch", "Test alert. No shift is open. Tap to see the volunteer page.", EVENTS[0], "urgent") else 1)
    now = datetime.datetime.now()
    if now.year > 2026:
        print("RETIRED")
        return
    state = load_state()

    ok = True
    open_now, sold_out = {}, 0
    for url in EVENTS:
        time.sleep(1)
        page = fetch(url)
        options = shifts(page)
        if not options:
            ok = False
            log(f"no shifts parsed: {url}")
            continue
        name = event_name(page, url)
        for option_id, shift, status, plus_one, register_link in options:
            if not plus_one:
                continue
            if register_link:
                open_now[option_id] = (name, shift, status, register_link)
            else:
                sold_out += 1

    state["fails"] = 0 if ok else state["fails"] + 1
    if state["fails"] == BLIND_AFTER:
        notify("NYRR watcher can't read the site", "Failed 3 checks in a row. Check nyrr.org by hand until it recovers.")
        log("blind warning sent")
        print("BLIND")

    undelivered = set()
    for option_id, (name, shift, status, url) in open_now.items():
        if option_id not in state["open"]:
            if not notify("NYRR +1 shift open: grab it now", f"{name}: {shift}", url, "urgent"):
                undelivered.add(option_id)  # retried on the next run
            log(f"OPEN {name} | {shift} | {status} | {url}")
            print(f"NEW_OPEN {name} | {shift} | {url}")

    # A partly failed run must not forget open shifts, or they'd alert again on the next good run.
    state["open"] = sorted((set(open_now) - undelivered) | (set(state["open"]) if not ok else set()))

    today = now.strftime("%Y-%m-%d")
    if now.hour >= SUMMARY_HOUR and state["summary_day"] != today and ok:
        state["summary_day"] = today
        if open_now:
            listed = "; ".join(f"{n}: {s}" for n, s, _, _ in open_now.values())
            notify(f"NYRR: {len(open_now)} +1 shift(s) open", listed[:180])
        else:
            notify("NYRR: no +1 shifts open today", "Still watching the Ted Corbitt 15K (Dec 5).")

    log(f"events={len(EVENTS)} open={len(open_now)} sold_out={sold_out} ok={ok}")
    with open(STATE, "w") as f:
        json.dump(state, f)


if __name__ == "__main__":
    main()
