// RepoHealth — content script
// Detects a GitHub repo page, fetches public API data, computes a health
// score, and injects a badge near the repo title.

(function () {
  "use strict";

  const API = "https://api.github.com";
  const CACHE_TTL_MS = 1000 * 60 * 30; // 30 min

  // ---- Utilities -----------------------------------------------------------

  // Parse "owner/repo" from the current path, ignoring non-repo pages.
  function parseRepo() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    // Reserved top-level paths that look like owners but aren't repos.
    const reserved = new Set([
      "settings", "notifications", "explore", "topics", "trending",
      "marketplace", "sponsors", "features", "about", "pricing",
      "orgs", "users", "search", "new", "login", "logout", "join",
      "pulls", "issues", "codespaces", "dashboard"
    ]);
    if (reserved.has(parts[0])) return null;

    return { owner: parts[0], repo: parts[1] };
  }

  function daysSince(dateStr) {
    if (!dateStr) return Infinity;
    const then = new Date(dateStr).getTime();
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
  }

  function fmtDays(d) {
    if (d === Infinity) return "unknown";
    if (d < 1) return "today";
    if (d < 2) return "1 day ago";
    if (d < 30) return `${Math.round(d)} days ago`;
    if (d < 365) return `${Math.round(d / 30)} mo ago`;
    return `${(d / 365).toFixed(1)} yr ago`;
  }

  // ---- Just for fun: mood + quips ------------------------------------------

  // A little emoji "mood pet" that reflects the repo's health at a glance.
  const MOOD = {
    green: "😎",
    amber: "😐",
    red: "😴",
    gray: "💀"
  };

  // Snarky one-liners, picked at random per repo. Purely for personality.
  const QUIPS = {
    green: [
      "Shipping like there's no tomorrow.",
      "This repo drinks its coffee black.",
      "Maintainers still answer their DMs.",
      "Green flags all the way down."
    ],
    amber: [
      "Alive, but running on fumes.",
      "Occasionally remembers it has issues.",
      "Not dead — just resting its eyes.",
      "Weekend-project energy."
    ],
    red: [
      "Last seen touching grass.",
      "The maintainer moved on. Peacefully.",
      "Here lies a once-promising fork.",
      "Bring your own life support."
    ],
    gray: [
      "Officially retired. F to pay respects.",
      "Archived. It had a good run.",
      "This one's in the museum now."
    ]
  };

  function pickQuip(color) {
    const list = QUIPS[color] || QUIPS.gray;
    return list[Math.floor(Math.random() * list.length)];
  }

  // Rare little celebration when you stumble onto a near-perfect repo.
  function confetti() {
    const N = 80;
    const wrap = document.createElement("div");
    wrap.className = "rh-confetti";
    const colors = ["#1a7f37", "#d4a72c", "#cf222e", "#0969da", "#8250df"];
    for (let i = 0; i < N; i++) {
      const p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = Math.random() * 0.6 + "s";
      p.style.animationDuration = 1.8 + Math.random() * 1.2 + "s";
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      wrap.appendChild(p);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3500);
  }

  // ---- Data fetching (with light caching) ----------------------------------

  async function getJSON(url) {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") throw new Error("RATE_LIMIT");
    }
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  }

  async function cachedFetch(key, fetcher) {
    try {
      const cached = await chrome.storage.local.get(key);
      const entry = cached[key];
      if (entry && Date.now() - entry.t < CACHE_TTL_MS) {
        return entry.v;
      }
    } catch (e) { /* storage may be unavailable; ignore */ }

    const value = await fetcher();
    try {
      await chrome.storage.local.set({ [key]: { t: Date.now(), v: value } });
    } catch (e) { /* ignore */ }
    return value;
  }

  // Pull the signals we need. Kept to a small number of API calls.
  async function fetchSignals(owner, repo) {
    const base = `${API}/repos/${owner}/${repo}`;

    const meta = await getJSON(base);

    // Recent commits on the default branch (1 page = up to 30).
    let commits = [];
    try {
      commits = await getJSON(`${base}/commits?per_page=30`);
    } catch (e) { commits = []; }

    // Open issues+PRs count comes from meta.open_issues_count.
    // Get most-recently-updated open issues to gauge responsiveness.
    let recentIssues = [];
    try {
      recentIssues = await getJSON(
        `${base}/issues?state=all&sort=updated&per_page=20`
      );
    } catch (e) { recentIssues = []; }

    const fork = await fetchForkComparison(meta);

    return { meta, commits, recentIssues, fork };
  }

  // For a fork, how far has it drifted from the repo it came from?
  // meta.parent is already embedded in the repo response, so this costs
  // one extra call (the compare) rather than two.
  async function fetchForkComparison(meta) {
    if (!meta.fork || !meta.parent) return null;

    const parent = meta.parent;
    const [parentOwner, parentRepo] = parent.full_name.split("/");
    const basehead =
      `${parent.default_branch}...${meta.owner.login}:${meta.default_branch}`;

    try {
      const cmp = await getJSON(
        `${API}/repos/${parentOwner}/${parentRepo}/compare/${basehead}`
      );
      return {
        parent: parent.full_name,
        parentArchived: !!parent.archived,
        ahead: cmp.ahead_by || 0,
        behind: cmp.behind_by || 0
      };
    } catch (e) {
      // Compare 404s on empty repos and can time out on wildly diverged
      // histories. The fork relationship is still worth surfacing.
      return { parent: parent.full_name, parentArchived: !!parent.archived };
    }
  }

  // Long-abandoned forks of busy repos run to seven figures behind, so
  // these need separators to stay readable.
  function fmtCount(n) {
    return n.toLocaleString();
  }

  // Compact form for the badge chip, where space is tight.
  function fmtCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  // Human-readable drift summary + whether it counts as healthy.
  function describeFork(fork) {
    if (fork.ahead == null || fork.behind == null) {
      return { text: `Fork of ${fork.parent}`, good: true };
    }
    const { ahead, behind } = fork;
    let text;
    if (!ahead && !behind) text = `In sync with ${fork.parent}`;
    else if (ahead && behind)
      text = `Diverged from ${fork.parent}: ${fmtCount(ahead)} ahead, ` +
             `${fmtCount(behind)} behind`;
    else if (behind)
      text = `${fmtCount(behind)} commit${behind === 1 ? "" : "s"} behind ` +
             `${fork.parent}`;
    else
      text = `${fmtCount(ahead)} commit${ahead === 1 ? "" : "s"} ahead of ` +
             `${fork.parent}`;

    return { text, good: behind <= 20, ahead, behind };
  }

  // ---- Scoring -------------------------------------------------------------

  // Returns { score: 0-100, label, color, factors: [...] }
  function computeHealth({ meta, commits, recentIssues, fork }) {
    const factors = [];
    let score = 0;

    // 1. Recency of last push (max 40 pts) — the single strongest "alive" signal.
    const lastPush = daysSince(meta.pushed_at);
    let pushPts;
    if (lastPush < 30) pushPts = 40;
    else if (lastPush < 90) pushPts = 30;
    else if (lastPush < 180) pushPts = 20;
    else if (lastPush < 365) pushPts = 10;
    else pushPts = 0;
    score += pushPts;
    factors.push({
      label: `Last push ${fmtDays(lastPush)}`,
      good: pushPts >= 20
    });

    // 2. Commit cadence over the recent window (max 25 pts).
    let cadencePts = 0;
    if (commits.length >= 2) {
      const newest = daysSince(commits[0]?.commit?.author?.date);
      const oldest = daysSince(
        commits[commits.length - 1]?.commit?.author?.date
      );
      const spanDays = Math.max(oldest - newest, 0.5);
      const perWeek = (commits.length / spanDays) * 7;
      if (perWeek >= 5) cadencePts = 25;
      else if (perWeek >= 1) cadencePts = 18;
      else if (perWeek >= 0.25) cadencePts = 10;
      else cadencePts = 4;
    } else if (commits.length === 1) {
      // Not enough commits to measure a rate — fall back to recency
      // so brand-new-but-active repos aren't scored as if they were dead.
      const age = daysSince(commits[0]?.commit?.author?.date);
      cadencePts = age < 30 ? 12 : 4;
    }
    score += cadencePts;
    factors.push({
      label: commits.length
        ? `${commits.length} recent commits`
        : "No recent commits",
      good: cadencePts >= 10
    });

    // 3. Issue responsiveness (max 20 pts): did maintainers touch issues lately?
    let respPts = 0;
    if (recentIssues.length) {
      const freshestUpdate = Math.min(
        ...recentIssues.map((i) => daysSince(i.updated_at))
      );
      if (freshestUpdate < 14) respPts = 20;
      else if (freshestUpdate < 45) respPts = 12;
      else if (freshestUpdate < 120) respPts = 6;
      else respPts = 0;
      factors.push({
        label: `Issues active ${fmtDays(freshestUpdate)}`,
        good: respPts >= 12
      });
    } else {
      respPts = 8; // no issues at all isn't necessarily bad
      factors.push({ label: "No open issue activity", good: true });
    }
    score += respPts;

    // 4. Archived / stale flags (can subtract).
    if (meta.archived) {
      score = Math.min(score, 15);
      factors.push({ label: "Archived by owner", good: false });
    }

    // 4b. Fork drift — shown as a signal, but left out of the score so the
    // 0-100 calibration keeps meaning "is this repo alive".
    let forkInfo = null;
    if (fork) {
      forkInfo = describeFork(fork);
      factors.push({ label: forkInfo.text, good: forkInfo.good });
      if (fork.parentArchived) {
        factors.push({ label: "Upstream is archived", good: false });
      }
    }

    // 5. Popularity as a weak positive (max 15 pts) — a proxy for "worth using".
    const stars = meta.stargazers_count || 0;
    let starPts;
    if (stars >= 5000) starPts = 15;
    else if (stars >= 500) starPts = 11;
    else if (stars >= 50) starPts = 7;
    else starPts = 3;
    score += starPts;
    factors.push({
      label: `${stars.toLocaleString()} stars`,
      good: stars >= 50
    });

    score = Math.max(0, Math.min(100, Math.round(score)));

    let label, color;
    if (meta.archived) {
      label = "Archived";
      color = "gray";
    } else if (score >= 70) {
      label = "Active";
      color = "green";
    } else if (score >= 45) {
      label = "Moderate";
      color = "amber";
    } else {
      label = "Likely stale";
      color = "red";
    }

    return { score, label, color, factors, fork: forkInfo };
  }

  // ---- Rendering -----------------------------------------------------------

  function removeExistingBadge() {
    const old = document.getElementById("repohealth-badge");
    if (old) old.remove();
  }

  function renderBadge(state) {
    removeExistingBadge();

    // GitHub has reshuffled this header markup before; try a few
    // fallbacks before giving up and just appending to the page.
    const anchor =
      document.querySelector('[itemprop="name"]')?.closest("strong")
        ?.parentElement ||
      document.querySelector("#repository-container-header h1") ||
      document.querySelector('main h1') ||
      document.querySelector("h1") ||
      document.body;

    const badge = document.createElement("div");
    badge.id = "repohealth-badge";
    badge.className = `rh-badge rh-${state.color || "loading"}`;

    if (state.loading) {
      badge.innerHTML = `<span class="rh-pill"><span class="rh-dot"></span><span class="rh-text">RepoHealth…</span></span>`;
    } else if (state.error) {
      const msg =
        state.error === "RATE_LIMIT"
          ? "GitHub API rate limit — try again shortly"
          : "RepoHealth: couldn't load";
      badge.innerHTML = `<span class="rh-pill"><span class="rh-dot"></span><span class="rh-text">${msg}</span></span>`;
    } else {
      const { score, label, color, factors, fork } = state;
      const mood = MOOD[color] || "";
      const quip = pickQuip(color);
      const tips = factors
        .map(
          (f) =>
            `<li class="${f.good ? "rh-ok" : "rh-bad"}">${f.label}</li>`
        )
        .join("");
      // Drift is the whole point of looking at a fork, so surface it on the
      // badge itself rather than burying it in the hover breakdown.
      const forkChip =
        fork && fork.behind
          ? `<span class="rh-fork ${fork.good ? "" : "rh-fork-warn"}">🍴 ${fmtCompact(fork.behind)} behind</span>`
          : "";
      badge.innerHTML = `
        <span class="rh-mood rh-mood-${color}">${mood}</span>
        <span class="rh-pill"><span class="rh-text"><strong>${label}</strong> · ${score}/100</span></span>
        ${forkChip}
        <div class="rh-tooltip">
          <div class="rh-tooltip-title">Health signals</div>
          <ul>${tips}</ul>
          <div class="rh-tooltip-quip">“${quip}”</div>
          <div class="rh-tooltip-foot">RepoHealth v0.1 · heuristic score</div>
        </div>
      `;
    }

    anchor.appendChild(badge);
  }

  // ---- Main ----------------------------------------------------------------

  // Bumped on every run() so a slow, superseded fetch can detect it's
  // stale and avoid overwriting the badge for whatever repo loaded after it.
  let runId = 0;

  async function run() {
    const repo = parseRepo();
    const myRunId = ++runId;

    if (!repo) {
      removeExistingBadge();
      return;
    }

    renderBadge({ loading: true });

    try {
      const cacheKey = `rh:${repo.owner}/${repo.repo}`;
      const signals = await cachedFetch(cacheKey, () =>
        fetchSignals(repo.owner, repo.repo)
      );
      if (myRunId !== runId) return; // a newer navigation has since started
      const health = computeHealth(signals);
      renderBadge(health);
      // Rare treat: celebrate a near-flawless repo, once per page load.
      if (health.score >= 95) confetti();
    } catch (e) {
      if (myRunId !== runId) return;
      renderBadge({ error: e.message || "ERROR" });
    }
  }

  // GitHub uses PJAX/turbo navigation, which fires several overlapping
  // signals for one page change. Dedup on pathname so we don't kick off
  // redundant API calls (and burn the 60/hr unauthenticated budget) for
  // the same navigation.
  let lastPath = null;
  function maybeRun() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    run();
  }

  maybeRun();

  const observer = new MutationObserver(maybeRun);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("turbo:load", maybeRun);
  document.addEventListener("pjax:end", maybeRun);
})();
