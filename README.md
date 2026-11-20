# Mokosveri Research

Stock and ETF research site on Cloudflare Workers (static assets + API + cron jobs, KV cache, D1 database).

## Deploy
Deploys run automatically: every push to `main` on GitHub triggers Cloudflare Workers Builds, which runs

    npx wrangler d1 migrations apply mokosveri-db --remote && npx wrangler deploy

so new files in `migrations/` are applied before the new code goes live. To deploy, commit and push to `main`.

Manual deploy (only if Builds is unavailable):

    npm install
    npx wrangler d1 migrations apply mokosveri-db --remote
    npx wrangler deploy

## Optional settings
- `SEC_USER_AGENT` (in wrangler.toml): SEC asks for "Name contact@email". Replace the placeholder.
- Secrets (set with `npx wrangler secret put NAME`):
  - `ADMIN_TOKEN`: lets you trigger jobs via POST /api/admin/{ingest|buzz|daily} with header x-admin-token.
  - `QUIVER_API_KEY` or `FMP_API_KEY`: more reliable congressional trade data (free Capitol Trades feed is used otherwise).

## Test offline
    npm test

## Accounts, watchlists and pinned tickers
- Sign up is invite only and capped at 20 accounts. The first account created becomes the admin.
- Create the very first invite once (pick your own code):
    npx wrangler d1 execute mokosveri-db --remote --command "INSERT INTO invites (code, created_at) VALUES ('your-secret-code', 0)"
  then open /#/signup?code=your-secret-code. After that, make invites from the Watchlist page (admin section).
- Optional Cloudflare Turnstile human check on login and sign up: put the site key in wrangler.toml [vars] as TURNSTILE_SITE_KEY and run `npx wrangler secret put TURNSTILE_SECRET`. It switches on only when both are set.
- Login and sign up are rate limited per IP and per username.
