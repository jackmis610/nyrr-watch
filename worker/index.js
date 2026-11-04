// Starts the GitHub watcher every 15 minutes, 5am-11pm Mountain, through 2026.
// GitHub's own schedule skips most runs; runs started through the API start right away.
const REPO = "jackmis610/nyrr-watch";

function mountain(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", year: "numeric", hour: "numeric", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), hour: get("hour") };
}

export default {
  async scheduled(event, env) {
    const now = new Date(event.scheduledTime);
    const { year, hour } = mountain(now);
    if (year > 2026 || hour < 5 || hour >= 23) return;

    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/watch.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "nyrr-watch-timer",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (r.ok) return;
    console.log(`dispatch failed: ${r.status} ${await r.text()}`);

    // Once a day, so a broken token doesn't go unnoticed.
    if (hour === 9 && now.getUTCMinutes() < 15) {
      await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
        method: "POST",
        headers: { Title: "NYRR timer can't start checks", Priority: "high" },
        body: `GitHub answered ${r.status}. Checks now run only when GitHub's own schedule fires.`,
      });
    }
  },
};
