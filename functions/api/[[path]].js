// Cloudflare Pages Functions - The Slow Tide 反馈中心 API 代理
// /api/rest/* -> Supabase REST（反馈数据、admin_action、append_feedback 等）
// 口令在后端校验；追加评论走 service key 服务端追加；CORS 仅放行本站与官网

const SUPABASE_URL = 'https://jilcbcodphxpasicjghv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppbGNiY29kcGh4cGFzaWNqZ2h2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MDUzNTgsImV4cCI6MjEwNDE4MTM1OH0._DkyiWyL5viXByCJ5ejFifn9RuEVkVHjAnU4oQepsbs';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppbGNiY29kcGh4cGFzaWNqZ2h2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODYwNTM1OCwiZXhwIjoyMTA0MTgxMzU4fQ.M3y0gwO0u-9CJuYD3G_OFlnATlg-6bQ0FucA0qeLJAI';

function allowedOrigin(req) {
  const origin = req.headers.get('Origin') || '';
  const ok = ['https://theslowtide.pages.dev', 'https://theslowtidefk.pages.dev', 'http://localhost', 'http://127.0.0.1', 'null'];
  return ok.includes(origin) ? origin : '';
}
function corsHeaders(req) {
  const origin = allowedOrigin(req);
  return {
    'Access-Control-Allow-Origin': origin || 'https://theslowtidefk.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://theslowtidefk.pages.dev' } });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request) });
  }
  if (!path.startsWith('/api/rest/')) {
    return new Response('Not found', { status: 404 });
  }
  // 玩家追加评论：服务端用 service key 追加到描述（FFM5NE / 防滥用）
  if (path.endsWith('/rpc/append_feedback')) {
    return handleAppend(context);
  }
  // 管理接口按 IP 限速（HGTHEX 后端部分）
  if (path.includes('admin_action') && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = 'tstfb-admin-rate:' + ip;
    const env = context.env || {};
    if (env.TSTFB_KV) {
      const now = Date.now();
      const raw = await env.TSTFB_KV.get(key).catch(() => null);
      let rec = null;
      try { rec = raw ? JSON.parse(raw) : null; } catch (e) {}
      const n = rec && now - rec.ts < 60000 ? rec.n : 0;
      if (n >= 5) {
        return new Response(JSON.stringify({ error: 'too_many' }), { status: 429, headers: corsHeaders(request) });
      }
      await env.TSTFB_KV.put(key, JSON.stringify({ ts: now, n: n + 1 }), { expirationTtl: 60 }).catch(() => {});
    }
  }

  const target = SUPABASE_URL + path.slice('/api'.length) + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (!headers.get('apikey')) headers.set('apikey', SUPABASE_ANON);
  if (!headers.get('authorization')) headers.set('authorization', 'Bearer ' + SUPABASE_ANON);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method, headers: headers, body: body, redirect: 'manual' });
  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', allowedOrigin(request) || 'https://theslowtidefk.pages.dev');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

async function handleAppend(context) {
  const { request } = context;
  let obj = null;
  try { obj = await request.json(); } catch (e) { return json({ error: 'bad_request' }, 400); }
  const id = String((obj && obj.p_feedback_id) || '').trim();
  const text = String((obj && obj.p_text) || '').trim();
  if (!id || !text) return json({ error: 'missing_params' }, 400);
  if (text.length > 500) return json({ error: 'too_long' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const env = context.env || {};
  if (env.TSTFB_KV) {
    const key = 'tstfb-append-rate:' + ip;
    const now = Date.now();
    const raw = await env.TSTFB_KV.get(key).catch(() => null);
    let rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) {}
    const n = rec && now - rec.ts < 60000 ? rec.n : 0;
    if (n >= 2) return json({ error: 'too_many' }, 429);
    await env.TSTFB_KV.put(key, JSON.stringify({ ts: now, n: n + 1 }), { expirationTtl: 60 }).catch(() => {});
  }
  const h = { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };
  try {
    const get = await fetch(SUPABASE_URL + '/rest/v1/Feedback?id=eq.' + encodeURIComponent(id) + '&select=id,description', { headers: h });
    if (get.status !== 200) return json({ error: 'not_found' }, 404);
    const rows = await get.json();
    if (!rows || !rows.length) return json({ error: 'not_found' }, 404);
    const desc = rows[0].description || '';
    const sep = desc ? '\n\n【追加补充】\n' : '';
    const patch = await fetch(SUPABASE_URL + '/rest/v1/Feedback?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: Object.assign({}, h, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ description: desc + sep + text })
    });
    if (patch.status === 204 || patch.ok) return json({ ok: true });
    return json({ error: 'update_failed' }, 500);
  } catch (e) {
    return json({ error: 'server_error' }, 500);
  }
}
