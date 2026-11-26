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

## Watchlist columns
Each watchlist picks its own columns with the Columns button (saved per list in `watchlists.columns`, migration 0005). The catalog, groups and defaults live in `public/wlcols.js`, shared by the page and the Worker. Price, returns, YTD, RSI, moving average gaps and the 52 week range come from the 1 year chart; P/E, forward P/E, P/B, market cap, analyst rating, EPS, next earnings date, dividend yield, ex-dividend date and volume come from one batched Yahoo quote call (`src/sources/quotestats.js`, cached 30 minutes, only fetched when one of those columns is shown); beta is worked out from a year of daily returns against SPY.

## Under the radar
The Under the radar page (#/radar, API /api/radar) ranks small and mid caps that look ready to break out. Candidates come from open market insider buys (30 days), congressional buys (45 days), Reddit names whose mentions are climbing from a low base (the 15 most mentioned are skipped) and StockTwits trending. A batched Yahoo quote keeps stocks from $30M to $15B market cap, priced over $1, trading at least $250K a day. Anything up 20% or more over 1 or 3 months (or 15% in a week) is dropped and listed separately. Each pick gets a 0 to 99 breakout score (insider size and clustering, Congress, buzz, chart setup: coil, volatility squeeze, accumulation, distance to the 60 day high, plus headline tone), a buy trigger, a target and the level where the setup fails. Rules and weights live in `src/radar.js` (`LIMITS` and the `*Points` functions). The board is cached in D1 for 45 minutes and served stale for up to 12 hours while it rebuilds.

## Market events
The Market events page (#/events, API /api/events) lists recent and upcoming market moving events with an impact rating, actual vs expected for released data, and a plain language note on what each could mean. Official calendars with no free API (Fed, BLS, BEA, Census, NYSE holidays, Russell, OPEC+, the federal funding deadline) are typed into `OFFICIAL` in `src/events.js` and run through `OFFICIAL_THROUGH`; extend both when agencies publish new schedules. Options expiration, VIX expiration, S&P and Nasdaq 100 rebalances, jobless claims and ISM dates are computed. Live feeds (Nasdaq economic, earnings, IPO and split calendars, Yahoo earnings dates, Treasury auctions) are optional, cached in D1, and limited per request so the page fills in over a few visits.

## Dividend aristocrats
The Dividend aristocrats page (#/dividends, API /api/dividends) lists all 69 S&P 500 Dividend Aristocrats and 15 popular dividend ETFs (`ETFS` in `src/dividends.js`: growth, aristocrat, high yield, international and covered call funds, with expense ratios; ETF yield is trailing 12 month distributions over price, from one chart call per fund), filtered by default to yields of 2% or more and ranked by approximate total return (price return plus trailing yield) over 1 year, with YTD, 5 year and yield sorts. Prices, yields and returns are live from Yahoo (one batched quote call and four spark calls, cached 3 hours). Membership and years of raises are typed into `ARISTOCRATS` in `src/dividends.js`; update them after S&P's January review. The r/dividends section counts aristocrat mentions in top recent posts (cached 6 hours; Reddit sometimes refuses cloud servers, and the page says so) alongside summarized community themes and dated research notes in `COMMUNITY` and `RESEARCH`.

The page also has a dividend income calculator (`public/divcalc.js`). One holding: a dividend stock from the aristocrats list (highest yield first, 20 at a time with Load more), an income ETF, or any ticker typed in, with amount, timeframe, dividend growth, price growth and a DRIP toggle. Pool several together: tick any mix of stocks and ETFs, or add any ticker, set an amount for each, and see the combined yield, yearly income and total. Income ETFs are the 15 in `ETFS` plus `INCOME_FUNDS` (more dividend, covered call, real estate, preferred, bond and Treasury bill funds such as SGOV; served by `/api/dividends/funds`, one quote plus one chart call per fund, cached 3 hours, kept out of the ETF table), grouped by type (`CATS` in `public/divcalc.js`). Yield and dividend growth for a ticker come from `/api/dividends/calc/:ticker` (`dividendCalc`: 10 years of monthly Yahoo chart data plus a quote, cached 6 hours). Growth is the compound change in yearly payouts over the last 5 full years, held between -10% and 15% in projections; Treasury bill, bond and preferred funds (and typed T-bill tickers like BIL) are projected flat, 0% payout and price growth.

## ETF tax status
Every ETF shows how its payout is taxed and the account type it usually suits best (`public/etftax.js`): a Taxes and best account card on the ETF's page, a Taxes column and a guide under the dividend ETF table, a line in the income calculator, and an optional ETF tax watchlist column. Types cover qualified dividends, foreign withholding, covered call income (ordinary, or 60/40 index options with return of capital), REITs, preferreds, bonds, Treasuries (no state tax), munis, futures funds (K-1 or 1099), physical metals (collectibles), spot crypto, MLP funds and leveraged funds. About 240 popular tickers are typed into `KNOWN`; anything else is classified from its Yahoo category and name and labelled as a guess. Every view carries a not tax advice note.

## Breakout watch
The top of the home page shows six stocks that look set up to break out upward (API `/api/breakout`, built by `src/breakout.js`, rebuilt hourly from visitor traffic, admin rebuild `POST /api/admin/breakout`). Candidates come from the insider buys (SEC Form 4 store and OpenInsider), Congress purchases and accelerating Reddit and StockTwits chatter. Each one is priced, and ETFs, stocks under $1 or trading under $500K a day, and anything up 20% or more over 1, 2 or 3 months (or 20% off its 3 month low) are dropped. The rest get a 0 to 100 setup score: insiders up to 35, chart setup up to 25 (Bollinger squeeze, quiet accumulation, sitting just under the 3 month high, above its 50 and 200 day averages), Congress up to 15, social up to 15 and headlines up to 10 for the leading ten, with a bonus when three or more agree and points off for a stretched chart. The dashed line on each panel is the 3 month high to clear.
