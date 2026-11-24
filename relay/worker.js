// Pulse ↔ WHOOP official API relay (Cloudflare Worker).
//
// Why: WHOOP's official API needs a client secret (which must never be in a web app) and does not
// allow calls from browsers. This Worker keeps the secret, does the OAuth exchange, refreshes
// tokens, and forwards read-only API calls for your Pulse app only. It stores nothing.
//
// Environment (Cloudflare → Worker → Settings → Variables and secrets):
//   WHOOP_CLIENT_ID      (secret)  from developer-dashboard.whoop.com
//   WHOOP_CLIENT_SECRET  (secret)
//   APP_URL              (text)    e.g. https://joelmadeira26.github.io/stress-tracking-whoop/

const WHOOP = 'https://api.prod.whoop.com';
const SCOPES = 'offline read:recovery read:cycles read:sleep read:profile';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const app = new URL(env.APP_URL);
    const origin = app.origin;
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const redirectUri = `${url.origin}/callback`;

    // 1) Start sign-in: send the user to WHOOP.
    if (url.pathname === '/login') {
      const state = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join(''); // 8 chars
      const auth = new URL(`${WHOOP}/oauth/oauth2/auth`);
      auth.search = new URLSearchParams({ response_type: 'code', client_id: env.WHOOP_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES, state }).toString();
      return new Response(null, {
        status: 302,
        headers: { Location: auth.toString(), 'Set-Cookie': `pulse_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` },
      });
    }

    // 2) WHOOP sends the user back here: swap the code for tokens, hand them to the app in the URL fragment.
    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state');
      const cookie = (request.headers.get('cookie') || '').match(/pulse_state=([a-f0-9]{8})/);
      const back = (params) => new Response(null, { status: 302, headers: { Location: `${env.APP_URL}#/whoop?${new URLSearchParams(params)}`, 'Set-Cookie': 'pulse_state=; Path=/; Max-Age=0' } });
      if (url.searchParams.get('error')) return back({ error: url.searchParams.get('error') });
      if (!cookie || cookie[1] !== state) return back({ error: 'state_mismatch' });
      const tok = await tokenRequest(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri });
      if (!tok.access_token) return back({ error: tok.error || 'token_failed' });
      return back({ at: tok.access_token, rt: tok.refresh_token || '', exp: String(tok.expires_in || 3600) });
    }

    // Everything below is for the app only.
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return json({ error: 'origin_not_allowed' }, 403);

    // 3) Refresh: the app sends its refresh token, gets a new pair (WHOOP rotates refresh tokens).
    if (url.pathname === '/refresh' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.refresh_token) return json({ error: 'missing_refresh_token' }, 400);
      const tok = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: body.refresh_token, scope: 'offline' });
      return json(tok, tok.access_token ? 200 : 401);
    }

    // 4) Read-only API calls: /api/v2/recovery?start=…  →  https://api.prod.whoop.com/developer/v2/recovery?start=…
    if (url.pathname.startsWith('/api/v2/') && request.method === 'GET') {
      const allowed = /^\/api\/v2\/(recovery|cycle|activity\/sleep|user\/profile\/basic)$/;
      if (!allowed.test(url.pathname)) return json({ error: 'path_not_allowed' }, 404);
      const res = await fetch(`${WHOOP}/developer${url.pathname.slice(4)}${url.search}`, {
        headers: { Authorization: request.headers.get('authorization') || '' },
      });
      return new Response(res.body, { status: res.status, headers: { ...cors, 'content-type': 'application/json' } });
    }

    if (url.pathname === '/') return json({ ok: true, service: 'pulse-whoop-relay' });
    return json({ error: 'not_found' }, 404);
  },
};

async function tokenRequest(env, params) {
  const res = await fetch(`${WHOOP}/oauth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET }).toString(),
  });
  return res.json().catch(() => ({ error: `http_${res.status}` }));
}
