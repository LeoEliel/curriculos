// Cloudflare Worker: serve os arquivos estáticos (public/) e a API do currículo.
//
// Rotas:
//   GET  /api/curriculo  -> dados públicos (JSON)
//   PUT  /api/curriculo  -> salva dados (requer sessão)
//   GET  /api/foto       -> foto (imagem)
//   PUT  /api/foto       -> envia foto (requer sessão, corpo = imagem)
//   GET  /api/sessao     -> { ok: boolean }
//   POST /api/login      -> { senha } -> cookie de sessão
//   POST /api/logout
//   /editar              -> página do currículo em modo edição
// As páginas HTML recebem os dados embutidos (window.__CURRICULO__) para
// abrir já com o conteúdo real, sem requisição extra.

const DATA_KEY = 'curriculo';
const FOTO_KEY = 'foto';
const COOKIE = 'cv_sess';
const SESSION_DAYS = 30;
const MAX_JSON = 512 * 1024;
const MAX_FOTO = 4 * 1024 * 1024;

const enc = new TextEncoder();

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function sessionSecret(env) {
  // SESSION_SECRET é opcional; sem ele, deriva da senha (trocar a senha derruba as sessões).
  return (env.SESSION_SECRET || '') + '|' + (env.EDIT_PASSWORD || '');
}

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return exp + '.' + (await hmac(sessionSecret(env), 'sess:' + exp));
}

async function isAuthed(request, env) {
  if (!env.EDIT_PASSWORD) return false;
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionSecret(env), 'sess:' + exp));
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

function sameOrigin(request) {
  // Proteção CSRF simples para escritas: Origin precisa bater com o host.
  const o = request.headers.get('Origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

async function api(request, env, url) {
  const p = url.pathname, m = request.method;
  if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(request)) return json({ erro: 'origem inválida' }, 403);

  if (p === '/api/curriculo') {
    if (m === 'GET') {
      const d = await env.CV.get(DATA_KEY);
      return new Response(d || 'null', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (m === 'PUT') {
      if (!(await isAuthed(request, env))) return json({ erro: 'não autorizado' }, 401);
      const body = await request.text();
      if (body.length > MAX_JSON) return json({ erro: 'dados grandes demais' }, 413);
      let d; try { d = JSON.parse(body); } catch { return json({ erro: 'JSON inválido' }, 400); }
      if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.nome !== 'string') return json({ erro: 'formato inválido' }, 400);
      if (typeof d.foto === 'string' && d.foto.startsWith('data:')) d.foto = '';
      await env.CV.put(DATA_KEY, JSON.stringify(d));
      return json({ ok: true });
    }
  }

  if (p === '/api/foto') {
    if (m === 'GET' || m === 'HEAD') {
      const { value, metadata } = await env.CV.getWithMetadata(FOTO_KEY, { type: 'arrayBuffer' });
      if (!value) return new Response('sem foto', { status: 404 });
      // URL versionada (?v=...) -> pode ficar em cache por muito tempo.
      const cache = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return new Response(m === 'HEAD' ? null : value, { headers: { 'content-type': (metadata && metadata.type) || 'image/jpeg', 'cache-control': cache } });
    }
    if (m === 'PUT') {
      if (!(await isAuthed(request, env))) return json({ erro: 'não autorizado' }, 401);
      const type = (request.headers.get('content-type') || '').split(';')[0];
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ erro: 'tipo de imagem inválido' }, 415);
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_FOTO) return json({ erro: 'imagem grande demais' }, 413);
      await env.CV.put(FOTO_KEY, buf, { metadata: { type } });
      return json({ ok: true, url: '/api/foto?v=' + Date.now().toString(36) });
    }
  }

  if (p === '/api/sessao' && m === 'GET') return json({ ok: await isAuthed(request, env), configurado: !!env.EDIT_PASSWORD });

  if (p === '/api/login' && m === 'POST') {
    if (!env.EDIT_PASSWORD) return json({ erro: 'Senha não configurada no servidor (secret EDIT_PASSWORD).' }, 503);
    let senha = '';
    try { senha = String((await request.json()).senha || ''); } catch {}
    // Compara HMACs (mesmo tamanho) para não vazar tempo/comprimento.
    const a = await hmac('login', senha), b = await hmac('login', env.EDIT_PASSWORD);
    if (!safeEqual(a, b)) {
      await new Promise(r => setTimeout(r, 600));
      return json({ erro: 'Senha incorreta.' }, 401);
    }
    const cookie = `${COOKIE}=${await makeSession(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (p === '/api/logout' && m === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  return json({ erro: 'não encontrado' }, 404);
}

async function page(request, env, assetPath) {
  const u = new URL(request.url);
  u.pathname = assetPath; u.search = '';
  const res = await env.ASSETS.fetch(new Request(u, request));
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const data = (await env.CV.get(DATA_KEY)) || 'null';
  // Escapa "<" para não fechar a tag <script> por acidente.
  const inline = `<script>window.__CURRICULO__=${data.replace(/</g, '\\u003c')};</script>`;
  const out = new HTMLRewriter().on('head', { element(e) { e.prepend(inline, { html: true }); } }).transform(res);
  const h = new Headers(out.headers);
  h.set('cache-control', 'no-cache');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  if (assetPath === '/curriculo') h.set('x-robots-tag', request.url.includes('/editar') ? 'noindex' : 'all');
  return new Response(out.body, { status: out.status, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith('/api/')) return api(request, env, url);
    if (p === '/' || p === '/index.html') return page(request, env, '/');
    if (p === '/curriculo' || p === '/curriculo.html') return page(request, env, '/curriculo');
    if (p === '/editar' || p === '/editar/') return page(request, env, '/curriculo');
    return env.ASSETS.fetch(request);
  }
};
