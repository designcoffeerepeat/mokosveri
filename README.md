# Mokosveri Research

**Live site: [https://mokosveri.design-coffee-repeat.workers.dev](https://mokosveri.design-coffee-repeat.workers.dev)**

Stock and ETF research site on Cloudflare Workers (static assets + API + cron jobs, KV cache, D1 database).

## Deploy and scheduled jobs (all on Cloudflare, no GitHub Actions)
Everything runs on Cloudflare's free tier. The repo has no GitHub Actions workflows.

**Deploys.** Cloudflare Workers Builds is connected to this GitHub repo. Every push to `main` builds and deploys:

- Build command: `npm test` (a failing offline test stops the deploy)
- Deploy command: `npx wrangler d1 migrations apply mokosveri-db --remote && npx wrangler deploy`

so new files in `migrations/` are applied before the new code goes live. Pull request branches get preview builds. To deploy, commit and push to `main`.

To connect it (one time, in the Cloudflare dashboard): Workers & Pages, open `mokosveri`, Settings, Build, Connect, pick GitHub and `designcoffeerepeat/mokosveri`, branch `main`, then enter the two commands above.

**Scheduled jobs.** Cron Triggers in `wrangler.toml` run the Worker's `scheduled()` handler; they are deployed with the Worker, so nothing else needs setting up.

- `*/10 * * * *`: Form 4 insider ingest (every 10 min), buzz list (every 30 min), ticker table and cleanup (daily).
- `5 10,11,16,17,22,23 * * 1-5`: market events refresh at 6:05 AM, 12:05 PM and 6:05 PM New York time on weekdays (the UTC list covers daylight and standard time; the code skips the off hour). Pulls the live calendars into the D1 cache so `/api/events` loads full on the first visit.

Last run of each job: `/api/status`. Run one by hand (needs the `ADMIN_TOKEN` secret): `POST /api/admin/{ingest|buzz|daily|events}` with header `x-admin-token`. Cron runs are also listed in the dashboard under the Worker's Settings, Trigger events, and in its logs.

Manual deploy (only if Builds is unavailable):

    npm install
    npx wrangler d1 migrations apply mokosveri-db --remote
    npx wrangler deploy

## Optional settings
- `SEC_USER_AGENT` (in wrangler.toml): SEC asks for "Name contact@email". Replace the placeholder.
- Secrets (set with `npx wrangler secret put NAME`):
  - `ADMIN_TOKEN`: lets you trigger jobs via POST /api/admin/{ingest|buzz|daily|events} with header x-admin-token.
  - `QUIVER_API_KEY` or `FMP_API_KEY`: more reliable congressional trade data (free Capitol Trades feed is used otherwise).

## AI lenses
Each stock page has six AI lenses (stress test my thesis, margin trends, earnings quality, chart vs fundamentals, macro stress test, moat check). A lens runs only when tapped. It reads quarterly figures from SEC XBRL filings, the latest earnings press release (8-K), valuation and estimates from Yahoo, and the chart, then asks Workers AI for a short structured read. Results are cached for 12 hours per stock and lens.
- Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default. Set `LENS_MODEL` in wrangler.toml [vars] to change it; it falls back to `AI_MODEL` if the main model fails.
- Limits: 20 new lens runs per IP per hour and 300 per day site wide (saved reads do not count).

## Test offline
    npm test

## Accounts, watchlists and pinned tickers
- Sign up is invite only and capped at 20 accounts. The first account created becomes the admin.
- Create the very first invite once (pick your own code):
    npx wrangler d1 execute mokosveri-db --remote --command "INSERT INTO invites (code, created_at) VALUES ('your-secret-code', 0)"
  then open /#/signup?code=your-secret-code. After that, make invites from the Watchlist page (admin section).
- Optional Cloudflare Turnstile human check on login and sign up: put the site key in wrangler.toml [vars] as TURNSTILE_SITE_KEY and run `npx wrangler secret put TURNSTILE_SECRET`. It switches on only when both are set.
- Login and sign up are rate limited per IP and per username.

## Market events
The Market events page (#/events, API /api/events) lists recent and upcoming market moving events with an impact rating, actual vs expected for released data, and a plain language note on what each could mean. Official calendars with no free API (Fed, BLS, BEA, Census, NYSE holidays, Russell, OPEC+, the federal funding deadline) are typed into `OFFICIAL` in `src/events.js` and run through `OFFICIAL_THROUGH`; extend both when agencies publish new schedules. Options expiration, VIX expiration, S&P and Nasdaq 100 rebalances, jobless claims and ISM dates are computed. Live feeds (Nasdaq economic, earnings, IPO and split calendars, Yahoo earnings dates, Treasury auctions) are optional, cached in D1, and limited per request so the page fills in over a few visits.

## Dividend aristocrats
The Dividend aristocrats page (#/dividends, API /api/dividends) lists all 69 S&P 500 Dividend Aristocrats and 15 popular dividend ETFs (`ETFS` in `src/dividends.js`: growth, aristocrat, high yield, international and covered call funds, with expense ratios; ETF yield is trailing 12 month distributions over price, from one chart call per fund), filtered by default to yields of 2% or more and ranked by approximate total return (price return plus trailing yield) over 1 year, with YTD, 5 year and yield sorts. Prices, yields and returns are live from Yahoo (one batched quote call and four spark calls, cached 3 hours). Membership and years of raises are typed into `ARISTOCRATS` in `src/dividends.js`; update them after S&P's January review. The r/dividends section counts aristocrat mentions in top recent posts (cached 6 hours; Reddit sometimes refuses cloud servers, and the page says so) alongside summarized community themes and dated research notes in `COMMUNITY` and `RESEARCH`.
