# RepoHealth — v0.1.1

A Chrome extension that injects a **health badge** on any GitHub repo page so you can tell at a glance whether a project is alive, moderate, or likely stale — before you depend on it or sink hours into a PR.

## What it does right now (v0)
- Detects when you're on a `github.com/owner/repo` page
- Pulls public data from the GitHub API (last push, recent commit cadence, issue activity, stars, archived flag)
- Computes a 0–100 heuristic score → **Active / Moderate / Likely stale / Archived**
- Injects a colored pill badge next to the repo title; hover it for the breakdown of signals

## Changelog
**0.1.1**
- Fixed a race condition where fast repo-to-repo navigation could resolve out of order and leave a stale badge from a previously visited repo showing.
- Deduped the overlapping PJAX/Turbo/MutationObserver navigation signals so one page change no longer fires redundant API calls (helps stretch the unauthenticated rate limit).
- Brand-new repos with only one commit no longer score a flat 0 on commit cadence — a single recent commit now earns partial credit instead of being scored the same as no activity.
- Added fallback selectors for the badge anchor so it degrades more gracefully if GitHub tweaks the repo header markup.

## Install (loads in ~30 seconds)
1. Unzip `repohealth.zip` (or use the `repohealth/` folder directly)
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select the `repohealth` folder
5. Visit any repo, e.g. `https://github.com/facebook/react` (Active) vs. an abandoned one (Likely stale)

## Known v0 limits (deliberately scoped)
- Uses **unauthenticated** GitHub API → 60 requests/hour per IP. Results are cached 30 min per repo to stretch that. A later version will let you paste a personal token to raise the limit.
- Score is a heuristic, not ground truth. It's a fast signal, not a verdict.
- Badge placement uses GitHub's current DOM. It now tries a small chain of fallback selectors, but a big enough GitHub redesign could still require a tweak.

## Next steps toward shipping (this weekend → launch)
1. **Polish the anchor** so the badge sits cleanly on every repo layout (personal, org, forked).
2. **Optional token field** (popup) to lift the rate limit — needed before a public launch or heavy users will hit 403s.
3. **Free vs Pro split** for monetization: free = the badge; Pro (~$7 one-time via ExtensionPay) = extra signals (dependency freshness, "median PR merge time", bulk compare on search results pages).
4. **Launch assets**: a 15-second GIF of the badge flipping green vs. red on two repos. That clip is the whole marketing.
5. **Launch channels, same week**: Show HN, r/programming, r/opensource, Product Hunt, dev X/Twitter.

## Files
- `manifest.json` — MV3 config
- `content.js` — detection, fetching, scoring, badge injection
- `content.css` — badge + tooltip styling (light/dark)
- `icons/` — placeholder icons (replace before launch)
