// User accounts: invite-only signup (capped at MAX_USERS), PBKDF2 password
// hashing, HttpOnly session cookies, D1 rate limiting and optional Cloudflare
// Turnstile. The first account ever created becomes the admin.
import { json } from './util.js';

export const MAX_USERS = 20;
const SESSION_DAYS = 30;
const COOKIE = 'mk_session';
const PBKDF2_ITER = 100000; // Workers caps PBKDF2 at 100k iterations
const enc = new TextEncoder();

// ---------- crypto helpers ----------
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${toHex(salt)}$${toHex(dk)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const dk = await pbkdf2(password, fromHex(saltHex), parseInt(iter, 10));
  const want = fromHex(hashHex);
  if (dk.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < dk.length; i++) diff |= dk[i] ^ want[i];
  return diff === 0;
}

// A real hash to compare against when the username does not exist, so a
// wrong username takes as long as a wrong password.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

// ---------- validation ----------
export function cleanUsername(u) {
  const s = String(u || '').trim();
  return /^[A-Za-z0-9_]{3,24}$/.test(s) ? s : null;
}
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 200) return 'Password is too long.';
  return null;
}

// ---------- cookies and sessions ----------
function readCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function sessionCookie(token, maxAge, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const isSecure = (request) => new URL(request.url).protocol === 'https:';

async function createSession(env, request, userId) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 864e5)
    .run();
  return sessionCookie(token, SESSION_DAYS * 86400, isSecure(request));
}

// Returns { id, username, is_admin } or null.
export async function currentUser(env, request) {
  const token = readCookie(request, COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  )
    .bind(await sha256(token), Date.now())
    .first();
  return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;
}

// ---------- rate limiting (fixed window, stored in D1) ----------
// Returns true when the caller is still under the limit.
export async function rateLimit(env, key, max, windowSec) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (k, n, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN rate_limits.reset_at < ?3 THEN 1 ELSE rate_limits.n + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at < ?3 THEN ?2 ELSE rate_limits.reset_at END
     RETURNING n`
  )
    .bind(key, now + windowSec * 1000, now)
    .first();
  return !row || row.n <= max;
}

const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'local';

// ---------- Turnstile (optional: on when both keys are configured) ----------
const turnstileOn = (env) => !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);

async function turnstileOk(env, request, token) {
  if (!turnstileOn(env)) return true;
  if (!token || typeof token !== 'string') return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('remoteip', clientIp(request));
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const d = await r.json();
    return !!d.success;
  } catch {
    return false;
  }
}

// ---------- request helpers ----------
// Mutating requests must be JSON. Browsers cannot send a cross-site JSON POST
// without a CORS preflight (which we never approve), so this plus SameSite
// cookies blocks CSRF.
export async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return null;
  try {
    const d = await request.json();
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

const userCount = async (env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;

// ---------- handlers ----------
// Returns a Response, or null when the path is not an auth route.
export async function handleAuth(request, env, path) {
  const method = request.method;

  if (path === '/api/auth/config' && method === 'GET') {
    const n = await userCount(env);
    return json({ turnstileSiteKey: turnstileOn(env) ? env.TURNSTILE_SITE_KEY : null, users: n, maxUsers: MAX_USERS, full: n >= MAX_USERS });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const u = await currentUser(env, request);
    return json({ user: u });
  }

  if (path === '/api/auth/signup' && method === 'POST') {
    const ip = clientIp(request);
    if (!(await rateLimit(env, `signup:${ip}`, 5, 3600))) return json({ error: 'Too many sign up attempts. Try again in an hour.' }, 429);
    const body = await readJson(request);
    if (!body) return json({ error: 'Bad request.' }, 400);
    const username = cleanUsername(body.username);
    if (!username) return json({ error: 'Username must be 3 to 24 letters, numbers or underscores.' }, 400);
    const pp = passwordProblem(body.password);
    if (pp) return json({ error: pp }, 400);
    const code = String(body.invite || '').trim();
    if (!code || code.length > 64) return json({ error: 'An invite code is required.' }, 400);
    if (!(await turnstileOk(env, request, body.turnstile))) return json({ error: 'Human check failed. Please try again.' }, 400);

    if ((await userCount(env)) >= MAX_USERS) return json({ error: `This site is full (${MAX_USERS} accounts).` }, 403);
    const now = Date.now();
    const invite = await env.DB.prepare('SELECT code FROM invites WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(code, now).first();
    if (!invite) return json({ error: 'That invite code is not valid, already used, or expired.' }, 400);
    const taken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (taken) return json({ error: 'That username is taken.' }, 409);

    const hash = await hashPassword(body.password);
    // One transaction: the insert only happens while the cap and the invite
    // still hold, so two sign ups racing for the last slot or the same code
    // cannot both succeed. The first account ever becomes the admin.
    const [ins] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (username, pass_hash, is_admin, created_at)
         SELECT ?1, ?2, CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END, ?3
         WHERE (SELECT COUNT(*) FROM users) < ?4
           AND EXISTS (SELECT 1 FROM invites WHERE code = ?5 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?3))
           AND NOT EXISTS (SELECT 1 FROM users WHERE username = ?1)`
      ).bind(username, hash, now, MAX_USERS, code),
      env.DB.prepare(
        `UPDATE invites SET used_by = (SELECT id FROM users WHERE username = ?1), used_at = ?2
         WHERE code = ?3 AND used_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE username = ?1 AND created_at = ?2)`
      ).bind(username, now, code),
    ]);
    if (!ins.meta || !ins.meta.changes) return json({ error: 'Could not create the account. The invite may have just been used or the site is full.' }, 409);
    const user = await env.DB.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').bind(username).first();
    await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, user.id).run();
    const cookie = await createSession(env, request, user.id);
    return json({ user: { id: user.id, username: user.username, isAdmin: !!user.is_admin } }, 200, { 'set-cookie': cookie });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const ip = clientIp(request);
    if (!(await rateLimit(env, `login:${ip}`, 10, 900))) return json({ error: 'Too many login attempts. Try again in 15 minutes.' }, 429);
    const body = await readJson(request);
    if (!body) return json({ error: 'Bad request.' }, 400);
    const username = cleanUsername(body.username);
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    if (!username || !password) return json({ error: 'Wrong username or password.' }, 401);
    if (!(await rateLimit(env, `login-user:${username.toLowerCase()}`, 10, 900))) return json({ error: 'Too many login attempts for this account. Try again in 15 minutes.' }, 429);
    if (!(await turnstileOk(env, request, body.turnstile))) return json({ error: 'Human check failed. Please try again.' }, 400);
    const user = await env.DB.prepare('SELECT id, username, pass_hash, is_admin FROM users WHERE username = ?').bind(username).first();
    if (!user) {
      await dummyVerify(password);
      return json({ error: 'Wrong username or password.' }, 401);
    }
    if (!(await verifyPassword(password, user.pass_hash))) return json({ error: 'Wrong username or password.' }, 401);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now),
    ]);
    const cookie = await createSession(env, request, user.id);
    return json({ user: { id: user.id, username: user.username, isAdmin: !!user.is_admin } }, 200, { 'set-cookie': cookie });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(request, COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0, isSecure(request)) });
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const u = await currentUser(env, request);
    if (!u) return json({ error: 'Please log in.' }, 401);
    if (!(await rateLimit(env, `pw:${u.id}`, 10, 900))) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    const body = await readJson(request);
    if (!body) return json({ error: 'Bad request.' }, 400);
    const pp = passwordProblem(body.newPassword);
    if (pp) return json({ error: pp }, 400);
    const row = await env.DB.prepare('SELECT pass_hash FROM users WHERE id = ?').bind(u.id).first();
    if (!row || !(await verifyPassword(String(body.currentPassword || '').slice(0, 200), row.pass_hash))) return json({ error: 'Current password is wrong.' }, 401);
    // Changing the password signs out every other session.
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(body.newPassword), u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    ]);
    const cookie = await createSession(env, request, u.id);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  // ---------- admin ----------
  if (path.startsWith('/api/auth/admin/')) {
    const u = await currentUser(env, request);
    if (!u || !u.isAdmin) return json({ error: 'Admins only.' }, 403);
    const now = Date.now();

    if (path === '/api/auth/admin/overview' && method === 'GET') {
      const [users, invites] = await env.DB.batch([
        env.DB.prepare('SELECT u.id, u.username, u.is_admin, u.created_at, u.last_login, (SELECT COUNT(*) FROM watchlist_items i JOIN watchlists l ON l.id = i.list_id WHERE l.user_id = u.id) AS watching FROM users u ORDER BY u.created_at'),
        env.DB.prepare('SELECT i.code, i.note, i.created_at, i.expires_at, i.used_at, u.username AS used_by FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50'),
      ]);
      return json({ users: users.results, invites: invites.results, maxUsers: MAX_USERS });
    }

    if (path === '/api/auth/admin/invites' && method === 'POST') {
      const body = (await readJson(request)) || {};
      const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)').bind(now).first();
      if (open.n >= 20) return json({ error: 'You already have 20 unused invites. Revoke some first.' }, 400);
      const days = Math.min(Math.max(parseInt(body.days, 10) || 7, 1), 90);
      const code = randomToken(9);
      const note = String(body.note || '').trim().slice(0, 80) || null;
      await env.DB.prepare('INSERT INTO invites (code, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(code, note, u.id, now, now + days * 864e5).run();
      return json({ code, expiresAt: now + days * 864e5 });
    }

    const inv = path.match(/^\/api\/auth\/admin\/invites\/([A-Za-z0-9_-]{1,64})$/);
    if (inv && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').bind(inv[1]).run();
      return json({ ok: true });
    }

    const del = path.match(/^\/api\/auth\/admin\/users\/(\d+)$/);
    if (del && method === 'DELETE') {
      const id = parseInt(del[1], 10);
      if (id === u.id) return json({ error: 'You cannot delete your own admin account.' }, 400);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM watchlist_items WHERE list_id IN (SELECT id FROM watchlists WHERE user_id = ?)').bind(id),
        env.DB.prepare('DELETE FROM watchlists WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM watchlist WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  return path.startsWith('/api/auth/') ? json({ error: 'Not found' }, 404) : null;
}
