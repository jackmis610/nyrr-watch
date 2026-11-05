// Checks NYRR's Ted Corbitt 15K volunteer page for reopened +1 shifts every minute, 5am-11pm Mountain, through 2026,
// and alerts phones through ntfy. Openings have been taken within 15 minutes, so the check runs here
// rather than on GitHub, whose runners take 20-30 seconds to start. State lives in KV. If NYRR can't
// be read from Cloudflare, it starts the GitHub watcher every 15 minutes instead.
const REPO = "jackmis610/nyrr-watch";
// Only the Ted Corbitt 15K (Dec 5): NYRR won't let a runner volunteer at a race they're entered in,
// and Ted Corbitt is the race being cancelled to free a shift. The other three are entered as races.
const EVENTS = [
  "https://www.nyrr.org/races-and-events/2026/nyrr-ted-corbitt-15k-volunteers",
];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BLIND_AFTER = 15; // failed checks in a row (minutes) before warning and falling back to GitHub
// Cookies by host. Kept while Cloudflare reuses this isolate, so later checks skip the Queue-it
// redirects, which cost three extra requests of the free plan's 10 ms CPU budget.
const jar = new Map();
const SUMMARY_HOUR = 8; // local hour of the once-a-day "still watching" notification

function mountain(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: Number(get("year")), hour: Number(get("hour")), day: `${get("year")}-${get("month")}-${get("day")}` };
}

const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e]);

// Follows NYRR's Queue-it redirects by hand, carrying each host's cookies, as curl -L with a jar does.
async function fetchPage(url, jar) {
  for (let hop = 0; hop < 8; hop++) {
    const host = new URL(url).host;
    const cookies = jar.get(host) || new Map();
    const r = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA, Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const line of r.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    jar.set(host, cookies);
    if (r.status >= 300 && r.status < 400 && r.headers.get("Location")) {
      url = new URL(r.headers.get("Location"), url).href;
      continue;
    }
    return r.ok ? r.text() : "";
  }
  return "";
}

// Every registration option on an event page; only bookable ones carry a Register link.
function shifts(html) {
  return html.split('data-registration-option-id="').slice(1).flatMap((rest) => {
    const end = rest.indexOf("</article>"); // indexOf, not split: split would scan the whole rest of the page
    const chunk = end < 0 ? rest : rest.slice(0, end);
    const status = /data-event-status="([^"]+)"/.exec(chunk);
    const name = /<h3[^>]*><span>([\s\S]*?)<\/span>/.exec(chunk);
    if (!status || !name) return [];
    const link = /href="(https:\/\/register\.nyrr\.org\/[^"]+)"/.exec(chunk);
    return [{
      id: chunk.split('"')[0],
      name: unescape(name[1]).trim(),
      plusOne: /<li><span[^>]*>9\+1<\/span><\/li>/.test(chunk),
      link: link && unescape(link[1]),
    }];
  });
}

function eventName(html, url) {
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  return (title ? unescape(title[1]).trim() : url.split("/").pop()).replace(/\s*-\s*Volunteers?$/, "");
}

async function notify(env, title, body, url, priority = "default") {
  const headers = { Title: title, Priority: priority };
  if (url) headers.Click = url;
  try {
    const r = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", headers, body });
    return r.ok;
  } catch {
    return false;
  }
}

async function dispatchGitHub(env) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/watch.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "nyrr-watch-timer" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!r.ok) console.log(`dispatch failed: ${r.status} ${await r.text()}`);
}

export default {
  async scheduled(event, env) {
    const now = new Date(event.scheduledTime);
    const { year, hour, day } = mountain(now);
    if (year > 2026 || hour < 5 || hour >= 23) return;

    const saved = (await env.STATE.get("state")) || '{"open": [], "fails": 0, "summary_day": ""}';
    const state = JSON.parse(saved);

    let ok = true;
    let soldOut = 0;
    const openNow = new Map();
    for (const url of EVENTS) {
      let page = "";
      try {
        page = await fetchPage(url, jar);
      } catch (e) {
        console.log(`fetch error ${url}: ${e}`);
      }
      const options = shifts(page);
      if (!options.length) {
        ok = false;
        console.log(`no shifts parsed: ${url}`);
        continue;
      }
      const name = eventName(page, url);
      for (const s of options) {
        if (!s.plusOne) continue;
        if (s.link) openNow.set(s.id, { name, shift: s.name, url: s.link });
        else soldOut += 1;
      }
    }

    state.fails = ok ? 0 : Math.min(state.fails + 1, BLIND_AFTER + 1); // capped, so a long outage stops writing
    if (state.fails === BLIND_AFTER) {
      await notify(env, "NYRR watcher can't read the site", "Failed for 15 minutes. Falling back to GitHub checks every 15 minutes.");
    }
    if (state.fails >= BLIND_AFTER && now.getUTCMinutes() % 15 === 0) await dispatchGitHub(env);

    const undelivered = new Set();
    for (const [id, o] of openNow) {
      if (state.open.includes(id)) continue;
      if (!(await notify(env, "NYRR +1 shift open: grab it now", `${o.name}: ${o.shift}`, o.url, "urgent"))) undelivered.add(id);
      console.log(`OPEN ${o.name} | ${o.shift} | ${o.url}`);
    }
    // A partly failed check must not forget open shifts, or they'd alert again on the next good one.
    const keep = new Set([...openNow.keys()].filter((id) => !undelivered.has(id)));
    if (!ok) state.open.forEach((id) => keep.add(id));
    state.open = [...keep].sort();

    if (hour >= SUMMARY_HOUR && state.summary_day !== day && ok) {
      state.summary_day = day;
      if (openNow.size) {
        const listed = [...openNow.values()].map((o) => `${o.name}: ${o.shift}`).join("; ");
        await notify(env, `NYRR: ${openNow.size} +1 shift(s) open`, listed.slice(0, 180));
      } else {
        await notify(env, "NYRR: no +1 shifts open today", "Still watching the Ted Corbitt 15K (Dec 5).");
      }
    }

    console.log(`events=${EVENTS.length} open=${openNow.size} sold_out=${soldOut} ok=${ok}`);
    const next = JSON.stringify(state);
    if (next !== saved) await env.STATE.put("state", next);
  },
};
