// Cloudflare Pages Functions - TST 反馈平台 API
// 使用 D1 数据库，图片以 base64 存在数据库里，无需对象存储
// 绑定要求：D1 数据库变量名 DB
// 追加评论 append_feedback：D1 内追加文本；管理员口令后端校验

const ADMIN_PASSWORD = 'WYJQQNDYWHM';
let _migrated = false;
async function ensureColumn(env) {
  if (_migrated) return;
  try {
    const { results } = await env.DB.prepare('PRAGMA table_info(Feedback)').all();
    if (!(results || []).some(r => r.name === 'is_public')) {
      await env.DB.prepare('ALTER TABLE Feedback ADD COLUMN is_public INTEGER DEFAULT 1').run();
    }
  } catch (e) {}
  _migrated = true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request) });
  }

  try {
    // ===== 玩家追加评论（FFM5NE）=====
    if (path === '/api/rest/v1/rpc/append_feedback' && request.method === 'POST') {
      const body = await request.json();
      const id = String((body && body.p_feedback_id) || '').trim();
      const text = String((body && body.p_text) || '').trim();
      if (!id || !text) return json({ error: 'missing_params' }, 400);
      if (text.length > 500) return json({ error: 'too_long' }, 400);
      const row = await env.DB.prepare('SELECT description FROM Feedback WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not_found' }, 404);
      const desc = row.description || '';
      const sep = desc ? '\n\n【追加补充】\n' : '';
      await env.DB.prepare('UPDATE Feedback SET description = ? WHERE id = ?').bind(desc + sep + text, id).run();
      return json({ ok: true });
    }

    // ===== Supabase 代理（运维通道：经 Cloudflare 边缘转发，解决直连不稳定）=====
    if (path === '/api/rest/v1/proxy' && request.method === 'POST') {
      const body = await request.json();
      const up = String(body.up || '');
      const method = String(body.method || 'GET').toUpperCase();
      if (!up.startsWith('/rest/v1/')) return json({ error: 'bad_path' }, 400);
      const key = String(body.key || '');
      const payload = body.body;
      const headers = {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': String(body.prefer || '')
      };
      const init = { method: method, headers: headers };
      if (payload !== undefined && payload !== null) { init.body = JSON.stringify(payload); }
      const res = await fetch('https://jilcbcodphxpasicjghv.supabase.co' + up, init);
      const text = await res.text();
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
    }

    // ===== 数据库查询 =====
    if (path === '/api/rest/v1/Feedback' && request.method === 'GET') {
      await ensureColumn(env);
      const isAdmin = url.searchParams.get('admin') === '1' && url.searchParams.get('pw') === ADMIN_PASSWORD;
      const sql = isAdmin
        ? 'SELECT * FROM Feedback ORDER BY created_at DESC LIMIT 500'
        : 'SELECT * FROM Feedback WHERE is_public = 1 ORDER BY created_at DESC LIMIT 500';
      const { results } = await env.DB.prepare(sql).all();
      const parsed = (results || []).map(parseRow);
      return json(parsed);
    }

    // ===== 数据库插入 =====
    if (path === '/api/rest/v1/Feedback' && request.method === 'POST') {
      const body = await request.json();
      const id = crypto.randomUUID();
      const no = body.no || ('TST-' + Date.now().toString(36).toUpperCase());
      await ensureColumn(env);
      const isPublic = (body.is_public === false || body.is_public === 'false' || body.is_public === 0 || body.is_public === '0') ? 0 : 1;
      await env.DB.prepare(
        `INSERT INTO Feedback (id, no, "gameId", type, description, "occurTime", contact, status, reply, images, is_public, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        id, no,
        body.gameId || '',
        body.type || 'other',
        body.description || '',
        body.occurTime || null,
        body.contact || null,
        'pending', '',
        JSON.stringify(body.images || []),
        isPublic
      ).run();
      const { results } = await env.DB.prepare('SELECT * FROM Feedback WHERE id = ?').bind(id).all();
      return json(results[0] ? [parseRow(results[0])] : []);
    }

    // ===== 管理员 RPC（登录/改状态/回复/删除）=====
    if (path === '/api/rest/v1/rpc/admin_action' && request.method === 'POST') {
      const body = await request.json();
      if (body.p_password !== ADMIN_PASSWORD) {
        return json('wrong_password');
      }
      if (body.p_action === 'login') return json('ok');
      if (body.p_action === 'update') {
        await env.DB.prepare(
          'UPDATE Feedback SET status = coalesce(?, status), reply = coalesce(?, reply), is_public = coalesce(?, is_public) WHERE id = ?'
        ).bind(body.p_status || null, body.p_reply || null, (body.p_is_public === undefined ? null : (body.p_is_public ? 1 : 0)), body.p_id).run();
        return json('ok');
      }
      if (body.p_action === 'delete') {
        await env.DB.prepare('DELETE FROM Feedback WHERE id = ?').bind(body.p_id).run();
        return json('ok');
      }
      return json('unknown_action');
    }

    return new Response('Not found', { status: 404 });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
    });
  }
}

// 把 D1 行的 images JSON 字符串解析成数组
function parseRow(row) {
  return {
    ...row,
    images: row.images ? safeParse(row.images) : []
  };
}

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return []; }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders(req) {
  const origin = req ? (req.headers.get('Origin') || '') : '';
  const allow = ['https://theslowtide.pages.dev', 'https://theslowtidefk.pages.dev', 'http://localhost', 'http://127.0.0.1', 'null'];
  const a = allow.includes(origin) ? origin : 'https://theslowtidefk.pages.dev';
  return {
    'Access-Control-Allow-Origin': a,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
