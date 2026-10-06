// Cloudflare Pages Functions - TST 反馈平台 API
// 使用 D1 数据库，图片以 base64 存在数据库里，无需对象存储
// 绑定要求：D1 数据库变量名 DB
// 追加评论 append_feedback：D1 内追加文本；管理员口令后端校验

const ADMIN_PASSWORD = 'WYJQQNDYWHM';
let _migrated = false;
let _voteMigrated = false;

async function ensureVoteTables(env) {
  if (_voteMigrated) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vote_topics (id TEXT PRIMARY KEY, title TEXT, options TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vote_records (id TEXT PRIMARY KEY, topic_id TEXT, device_id TEXT, ip TEXT, option_idx INTEGER, created_at TEXT DEFAULT (datetime('now')))`).run();
  } catch (e) {}
  _voteMigrated = true;
}

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '';
}
function deviceId(req, url) {
  const q = url ? (url.searchParams.get('dev') || '') : '';
  const f = q || (req.headers.get('X-Device-Id') || '');
  return (f && f.length >= 8 && f.length <= 80) ? f : '';
}
function voteResult(options, rows) {
  const total = rows.reduce((s, r) => s + r.n, 0) || 0;
  return {
    total: total,
    result: options.map((o, i) => {
      const c = rows.find(r => r.option_idx === i);
      const n = c ? c.n : 0;
      return { id: o.id, label: o.label, count: n, pct: total ? Math.round(n / total * 1000) / 10 : 0 };
    })
  };
}
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

    // ===== 调试码验证（后端校验，前端不含码表）=====
    if (path === '/api/debug/verify' && request.method === 'POST') {
      const body = await request.json();
      const code = String((body && body.code) || '').trim().toUpperCase();
      const table = {
        'TST-K3M9X7': 'glass',     // 液态玻璃主题
        'TST-X2W5V8': 'light',     // 浅色主题
        'TST-Q8N4R2': 'desktop',   // 强制桌面模式
        'TST-M7Z1P6': 'mobile',    // 强制移动模式
        'TST-H6D3B9': 'perf',      // 性能面板
        'TST-F5J8C4': 'dev',       // 开发者信息
        'TST-R2T7W1': 'reset',     // 清除强制模式
        'TST-G4N7QX': 'bench3d',   // 3D 性能渲染测试
        'TST-7KQ2WP': 'chat'       // 聊天室（官网↔游戏互通，内测）
      };
      const feature = table[code];
      if (!feature) return json({ ok: false, error: 'invalid' });
      return json({ ok: true, feature: feature });
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

    // ===== 管理员批量操作（自动化测试反馈治理）=====
    if (path === '/api/rest/v1/rpc/admin_bulk' && request.method === 'POST') {
      const body = await request.json();
      if (body.p_password !== ADMIN_PASSWORD) {
        return json('wrong_password');
      }
      await ensureColumn(env);
      if (body.p_action === 'set_auto_private') {
        const r = await env.DB.prepare("UPDATE Feedback SET is_public = 0 WHERE gameId = '自动化程序'").run();
        return json({ ok: true, changes: r.meta.changes });
      }
      if (body.p_action === 'set_auto_done') {
        const r = await env.DB.prepare("UPDATE Feedback SET status = 'done' WHERE gameId = '自动化程序' AND status != 'done'").run();
        return json({ ok: true, changes: r.meta.changes });
      }
      if (body.p_action === 'delete_auto_done') {
        const r = await env.DB.prepare("DELETE FROM Feedback WHERE gameId = '自动化程序' AND status = 'done'").run();
        return json({ ok: true, changes: r.meta.changes });
      }
      if (body.p_action === 'list_auto') {
        const { results } = await env.DB.prepare("SELECT id, no, type, description, status, created_at FROM Feedback WHERE gameId = '自动化程序' ORDER BY created_at DESC").all();
        return json(results || []);
      }
      return json('unknown_action');
    }

    // ===== 投票：状态查询（未投不给占比；已投返回占比）=====
    if (path === '/api/vote/state' && request.method === 'GET') {
      await ensureVoteTables(env);
      const topic = String(url.searchParams.get('topic') || 'default');
      const top = await env.DB.prepare('SELECT * FROM vote_topics WHERE id = ?').bind(topic).first();
      if (!top) return json({ error: 'not_found' }, 404);
      const options = safeParse(top.options) || [];
      const ip = clientIp(request);
      const dev = deviceId(request, url);
      const rec = await env.DB.prepare('SELECT * FROM vote_records WHERE topic_id = ? AND (ip = ? OR (device_id != "" AND device_id = ?)) ORDER BY created_at DESC LIMIT 1')
        .bind(topic, ip, dev).first();
      const out = { id: top.id, title: top.title, options: options.map(o => ({ id: o.id, label: o.label })), active: !!top.active, voted: !!rec, myOption: rec ? rec.option_idx : null };
      if (rec) {
        const rows = await env.DB.prepare('SELECT option_idx, COUNT(*) n FROM vote_records WHERE topic_id = ? GROUP BY option_idx').bind(topic).all();
        out.voteResult = voteResult(options, rows.results || []);
      }
      return json(out);
    }

    // ===== 投票：提交（设备+IP 双重防重复；一个设备只能投一次）=====
    if (path === '/api/vote/submit' && request.method === 'POST') {
      await ensureVoteTables(env);
      const body = await request.json();
      const topic = String((body && body.topic) || 'default');
      const optionIdx = Number(body && body.option);
      const top = await env.DB.prepare('SELECT * FROM vote_topics WHERE id = ? AND active = 1').bind(topic).first();
      if (!top) return json({ error: 'not_found' }, 404);
      const options = safeParse(top.options) || [];
      if (!(optionIdx >= 0 && optionIdx < options.length)) return json({ error: 'bad_option' }, 400);
      const ip = clientIp(request);
      const dev = deviceId(request, url);
      const dup = await env.DB.prepare('SELECT id FROM vote_records WHERE topic_id = ? AND (ip = ? OR (device_id != "" AND device_id = ?)) LIMIT 1').bind(topic, ip, dev).first();
      if (dup) return json({ error: 'already_voted' });
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO vote_records (id, topic_id, device_id, ip, option_idx) VALUES (?, ?, ?, ?, ?)').bind(id, topic, dev, ip, optionIdx).run();
      const rows = await env.DB.prepare('SELECT option_idx, COUNT(*) n FROM vote_records WHERE topic_id = ? GROUP BY option_idx').bind(topic).all();
      const vr = voteResult(options, rows.results || []);
      return json({ ok: true, myOption: optionIdx, total: vr.total, result: vr.result });
    }

    // ===== 投票：管理员（编辑题目/选项、重置、删除、启停、结果）=====
    if (path === '/api/vote/admin' && request.method === 'POST') {
      const body = await request.json();
      if (!body || body.p_password !== ADMIN_PASSWORD) {
        return json('wrong_password');
      }
      await ensureVoteTables(env);
      const act = body.p_action;
      if (act === 'list') {
        const { results } = await env.DB.prepare('SELECT * FROM vote_topics ORDER BY created_at DESC').all();
        const out = [];
        for (const t of (results || [])) {
          const cnt = await env.DB.prepare('SELECT COUNT(*) n FROM vote_records WHERE topic_id = ?').bind(t.id).first();
          out.push({ id: t.id, title: t.title, options: safeParse(t.options), active: !!t.active, votes: cnt.n });
        }
        return json(out);
      }
      if (act === 'save') {
        const id = String(body.id || '').trim() || ('vote-' + Date.now().toString(36));
        const title = String(body.title || '').trim();
        const opts = Array.isArray(body.options)
          ? body.options.map((o, i) => ({ id: i, label: String((o && o.label) || '').trim() })).filter(o => o.label)
          : [];
        if (!title || !opts.length) return json({ error: 'bad_params' }, 400);
        await env.DB.prepare('INSERT INTO vote_topics (id, title, options, active) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET title = excluded.title, options = excluded.options')
          .bind(id, title, JSON.stringify(opts)).run();
        return json({ ok: true, id: id });
      }
      if (act === 'delete_topic') {
        await env.DB.prepare('DELETE FROM vote_records WHERE topic_id = ?').bind(String(body.id || '')).run();
        await env.DB.prepare('DELETE FROM vote_topics WHERE id = ?').bind(String(body.id || '')).run();
        return json({ ok: true });
      }
      if (act === 'clear_records') {
        await env.DB.prepare('DELETE FROM vote_records WHERE topic_id = ?').bind(String(body.id || '')).run();
        return json({ ok: true });
      }
      if (act === 'toggle_active') {
        await env.DB.prepare('UPDATE vote_topics SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').bind(String(body.id || '')).run();
        return json({ ok: true });
      }
      if (act === 'result') {
        const topic = String(body.id || '');
        const top = await env.DB.prepare('SELECT * FROM vote_topics WHERE id = ?').bind(topic).first();
        if (!top) return json({ error: 'not_found' }, 404);
        const options = safeParse(top.options) || [];
        const rows = await env.DB.prepare('SELECT option_idx, COUNT(*) n FROM vote_records WHERE topic_id = ? GROUP BY option_idx').bind(topic).all();
        const vr = voteResult(options, rows.results || []);
        return json({ id: top.id, title: top.title, options: options, active: !!top.active, total: vr.total, result: vr.result });
      }
      return json('unknown_action');
    }


    // ===== 服务器工具：禁用物品 + 任务查询（D1，自动建表+种子）=====
    let _toolsReady = false;
    async function ensureToolsTables(env) {
      if (_toolsReady) return;
      try {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS ban_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, en_id TEXT, special TEXT, note TEXT, created_at TEXT)').run();
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chapter TEXT, title TEXT, target TEXT, status TEXT, created_at TEXT)').run();
        const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM ban_items').first();
        if (!r || !r.c) {
          const SEED_ITEMS = [
            ['发射器','dispenser','全部','防止高频红石与刷物'],
            ['末地水晶','end_crystal','全部','禁止破坏末地公共设施或恶意使用'],
            ['TNT','tnt','全部','防止炸毁地形与恶意破坏'],
            ['苔光菇铲','','全部','模组物品，禁止持有使用'],
            ['投掷器','dropper','全部','与发射器同理，防止高频刷物'],
            ['收纳袋','bundle','全部','防复制/高频交互类'],
            ['末地传送门框架','end_portal_frame','全部','禁止在生存模式放置，防漏洞利用'],
            ['末地游行杖','','全部','模组物品，禁止持有使用'],
            ['活塞','piston','全部','防止高频红石与卡顿设备'],
            ['漏斗','hopper','全部','防止高频红石与刷物'],
            ['基岩','bedrock','全部','禁止持有使用，防破坏边界'],
            ['苔光菇圣锤','','全部','模组物品，禁止持有使用'],
            ['苔光菇镐','','全部','模组物品，禁止持有使用'],
            ['黏性活塞','sticky_piston','全部','防止高频红石与卡顿设备']
          ];
          for (const it of SEED_ITEMS) {
            await env.DB.prepare("INSERT INTO ban_items (name,en_id,special,note,created_at) VALUES (?,?,?,?,datetime('now'))").bind(it[0],it[1],it[2],it[3]).run();
          }
        }
        const r2 = await env.DB.prepare('SELECT COUNT(*) AS c FROM tasks').first();
        if (!r2 || !r2.c) {
          const SEED_TASKS = [
            ['第一章 | 潮起','潮汐新生','首次登录服务器，累计在线≥5分钟','已领奖 · 目标完成 2/2'],
            ['第一章 | 潮起','长夜安然','提交一张床，累计在线时间≥15分钟','进行中 · 目标完成 1/2'],
            ['第一章 | 潮起','伐木启始','采集16块原木，累计在线时间≥10分钟','已领奖 · 目标完成 2/2'],
            ['第一章 | 潮起','完成第一章','提交泥土 0/1，前置已完成 1/2，全部完成后解锁','未解锁']
          ];
          for (const t of SEED_TASKS) {
            await env.DB.prepare("INSERT INTO tasks (chapter,title,target,status,created_at) VALUES (?,?,?,?,datetime('now'))").bind(t[0],t[1],t[2],t[3]).run();
          }
        }
      } catch (e) {}
      _toolsReady = true;
    }



    // ===== 聊天桥 + 服务器状态（官网 ↔ 游戏）v2 =====
    const BRIDGE_TOKEN = 'TST-BRIDGE-SLOWTIDE-2026';
    let _chatMigrated = false;
    async function ensureChatTables(env) {
      if (_chatMigrated) return;
      try {
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS chat_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, message TEXT, kind TEXT, ts TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','+8 hours')))").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS out_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT DEFAULT 'msg', sender TEXT DEFAULT '', text TEXT, result TEXT, status TEXT DEFAULT 'pending', ts TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','+8 hours')))").run();
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_status (id INTEGER PRIMARY KEY AUTOINCREMENT, online INTEGER, max INTEGER, latency INTEGER, players TEXT, ts TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','+8 hours')))").run();
        // 兼容旧表结构
        try { await env.DB.prepare("ALTER TABLE out_msgs ADD COLUMN kind TEXT DEFAULT 'msg'").run(); } catch (e) {}
        try { await env.DB.prepare("ALTER TABLE out_msgs ADD COLUMN sender TEXT DEFAULT ''").run(); } catch (e) {}
        try { await env.DB.prepare("ALTER TABLE out_msgs ADD COLUMN result TEXT").run(); } catch (e) {}
      } catch (e) {}
      _chatMigrated = true;
    }
    function bridgeOk(req) {
      return String(req.headers.get('x-bridge-token') || '') === BRIDGE_TOKEN;
    }

    // 指令特征检测：用于拒绝玩家借官网广播指令内容
    const CMD_WORDS = ['op','deop','give','gamemode','gamerule','effect','enchant','xp','kick','ban','pardon','whitelist','execute','fill','clone','setblock','summon','tp','teleport','title','scoreboard','tag','team','kill','clear','difficulty','weather','tickingarea','function','structure','locate','testfor','testforblock','playsound','stopsound','spreadplayers','setworldspawn','defaultgamemode','save','stop','reload','list','seed','say','me','spawnpoint','wsserver','crash','tps','time','set'];
    function looksLikeCmd(t) {
      const s = String(t || '').trim();
      if (!s) return false;
      if (s.startsWith('/')) return true;
      const m = /^([a-zA-Z]+)/.exec(s);
      return !!(m && CMD_WORDS.indexOf(m[1].toLowerCase()) >= 0);
    }

    // 游戏侧插件推送聊天（带 token 校验 + 10 秒去重）
    if (path === '/api/chat/receive' && request.method === 'POST') {
      if (!bridgeOk(request)) return json({ error: 'bad_token' }, 401);
      const b = await request.json();
      const sender = String(b.sender || '').trim().slice(0, 40);
      const message = String(b.message || '').trim().slice(0, 200);
      if (!sender || !message) return json({ error: 'need_fields' }, 400);
      await ensureChatTables(env);
      const dup = await env.DB.prepare("SELECT id FROM chat_logs WHERE sender = ? AND message = ? AND ts > datetime('now','+8 hours','-10 seconds') LIMIT 1").bind(sender, message).first();
      if (!dup) {
        await env.DB.prepare("INSERT INTO chat_logs (sender,message,kind) VALUES (?,?,?)").bind(sender, message, 'game').run();
      }
      return json({ ok: true });
    }

    // 官网发消息：带发言人昵称，写入聊天记录 + 进入待发队列
    if (path === '/api/chat/send' && request.method === 'POST') {
      const b = await request.json();
      const message = String(b.message || '').trim().slice(0, 200);
      const sender = String(b.sender || '官网').trim().slice(0, 24) || '官网';
      if (!message) return json({ error: 'empty' }, 400);
      if (looksLikeCmd(message)) return json({ error: 'command_blocked', msg: '消息包含指令内容，已被拒绝发送' }, 400);
      await ensureChatTables(env);
      await env.DB.prepare("INSERT INTO chat_logs (sender,message,kind) VALUES (?,?,?)").bind(sender, message, 'web').run();
      await env.DB.prepare("INSERT INTO out_msgs (kind,sender,text,status) VALUES ('msg',?,?, 'pending')").bind(sender, message).run();
      return json({ ok: true });
    }

    // 聊天历史（增量拉取）
    if (path === '/api/chat/history' && request.method === 'GET') {
      await ensureChatTables(env);
      const after = Number(url.searchParams.get('after') || 0) || 0;
      const rows = await env.DB.prepare('SELECT id, sender, message, kind, ts FROM chat_logs WHERE id > ? ORDER BY id ASC LIMIT 200').bind(after).all();
      return json({ messages: (rows.results || []).map(r => ({ id:r.id, sender:r.sender, message:r.message, kind:r.kind, ts:r.ts })) });
    }

    // 插件取件：发给游戏的消息/指令（取走即标记 sent）
    if (path === '/api/chat/pending' && request.method === 'GET') {
      if (!bridgeOk(request)) return json({ error: 'bad_token' }, 401);
      await ensureChatTables(env);
      const rows = await env.DB.prepare("SELECT * FROM out_msgs WHERE status = 'pending' ORDER BY id ASC LIMIT 20").all();
      const ids = (rows.results || []).map(r => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE out_msgs SET status = 'sent' WHERE id IN (${ph})`).bind(...ids).run();
      }
      return json({ messages: (rows.results || []).map(r => ({ id:r.id, kind:r.kind, sender:r.sender, text:r.text })) });
    }

    // 管理员指令：校验管理密码，进入待执行队列
    if (path === '/api/chat/cmd' && request.method === 'POST') {
      const b = await request.json();
      if (!b || b.pw !== ADMIN_PASSWORD) return json({ error: 'wrong_password' }, 401);
      const cmd = String(b.cmd || '').trim().slice(0, 200);
      if (!cmd) return json({ error: 'empty' }, 400);
      await ensureChatTables(env);
      await env.DB.prepare("INSERT INTO chat_logs (sender,message,kind) VALUES ('管理员',?,'sys')").bind('下发指令：' + cmd).run();
      await env.DB.prepare("INSERT INTO out_msgs (kind,sender,text,status) VALUES ('cmd','管理员',?, 'pending')").bind(cmd).run();
      return json({ ok: true });
    }

    // 机器人回传指令执行结果（带 token）
    if (path === '/api/chat/cmd-result' && request.method === 'POST') {
      if (!bridgeOk(request)) return json({ error: 'bad_token' }, 401);
      const b = await request.json();
      const id = Number(b.id || 0);
      const result = String(b.result || '').slice(0, 500);
      await ensureChatTables(env);
      if (id) {
        await env.DB.prepare("UPDATE out_msgs SET status='done', result=? WHERE id=? AND kind='cmd'").bind(result, id).run();
      }
      if (result.trim()) {
        await env.DB.prepare("INSERT INTO chat_logs (sender,message,kind) VALUES ('机器人',?,'sys')").bind(result.slice(0, 200)).run();
      }
      return json({ ok: true });
    }

    // 机器人上报服务器状态
    if (path === '/api/server-status/report' && request.method === 'POST') {
      if (!bridgeOk(request)) return json({ error: 'bad_token' }, 401);
      const b = await request.json();
      await ensureChatTables(env);
      await env.DB.prepare('INSERT INTO server_status (online, max, latency, players) VALUES (?,?,?,?)')
        .bind(Math.max(0, Number(b.online) || 0), Math.max(0, Number(b.max) || 0), Math.max(0, Number(b.latency) || 0), JSON.stringify(Array.isArray(b.players) ? b.players.slice(0, 50) : [])).run();
      await env.DB.prepare("DELETE FROM server_status WHERE id NOT IN (SELECT id FROM server_status ORDER BY id DESC LIMIT 30)").run();
      return json({ ok: true });
    }

    // 前端查询状态
    if (path === '/api/server-status' && request.method === 'GET') {
      await ensureChatTables(env);
      const row = await env.DB.prepare('SELECT * FROM server_status ORDER BY id DESC LIMIT 1').first();
      if (!row) return json({ status: 'offline', online: 0, max: 0, latency: 0, players: [], ts: null });
      return json({ status: 'online', online: row.online, max: row.max, latency: row.latency, players: JSON.parse(row.players || '[]'), ts: row.ts });
    }

    // 查询禁用物品
    if (path === '/api/tools/items' && request.method === 'GET') {
      await ensureToolsTables(env);
      const q = String(url.searchParams.get('q') || '').trim();
      let rows;
      if (q) {
        rows = await env.DB.prepare('SELECT * FROM ban_items WHERE name LIKE ? OR en_id LIKE ? ORDER BY id').bind('%'+q+'%','%'+q+'%').all();
      } else {
        rows = await env.DB.prepare('SELECT * FROM ban_items ORDER BY id').all();
      }
      return json((rows.results || []).map(r => ({ id:r.id, name:r.name, en_id:r.en_id||'', special:r.special||'全部', note:r.note||'' })));
    }

    // 查询任务
    if (path === '/api/tools/tasks' && request.method === 'GET') {
      await ensureToolsTables(env);
      const q = String(url.searchParams.get('q') || '').trim();
      let rows;
      if (q) {
        rows = await env.DB.prepare('SELECT * FROM tasks WHERE chapter LIKE ? OR title LIKE ? OR target LIKE ? ORDER BY id').bind('%'+q+'%','%'+q+'%','%'+q+'%').all();
      } else {
        rows = await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
      }
      return json((rows.results || []).map(r => ({ id:r.id, chapter:r.chapter||'', title:r.title||'', target:r.target||'', status:r.status||'' })));
    }

    // 新增禁用物品（管理员）
    if (path === '/api/tools/item' && request.method === 'POST') {
      const b = await request.json();
      if (b.pw !== ADMIN_PASSWORD) return json({ error: 'wrong_password' }, 401);
      await ensureToolsTables(env);
      const name = String(b.name || '').trim();
      if (!name) return json({ error: 'need_name' }, 400);
      await env.DB.prepare("INSERT INTO ban_items (name,en_id,special,note,created_at) VALUES (?,?,?,?,datetime('now'))").bind(name, String(b.en_id||'').trim(), String(b.special||'全部').trim(), String(b.note||'').trim()).run();
      return json({ ok: true });
    }
    if (path === '/api/tools/item_del' && request.method === 'POST') {
      const b = await request.json();
      if (b.pw !== ADMIN_PASSWORD) return json({ error: 'wrong_password' }, 401);
      await env.DB.prepare('DELETE FROM ban_items WHERE id = ?').bind(Number(b.id) || 0).run();
      return json({ ok: true });
    }

    // 新增任务（管理员）
    if (path === '/api/tools/task' && request.method === 'POST') {
      const b = await request.json();
      if (b.pw !== ADMIN_PASSWORD) return json({ error: 'wrong_password' }, 401);
      await ensureToolsTables(env);
      const title = String(b.title || '').trim();
      if (!title) return json({ error: 'need_title' }, 400);
      await env.DB.prepare("INSERT INTO tasks (chapter,title,target,status,created_at) VALUES (?,?,?,?,datetime('now'))").bind(String(b.chapter||'').trim(), title, String(b.target||'').trim(), String(b.status||'').trim()).run();
      return json({ ok: true });
    }
    if (path === '/api/tools/task_del' && request.method === 'POST') {
      const b = await request.json();
      if (b.pw !== ADMIN_PASSWORD) return json({ error: 'wrong_password' }, 401);
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(Number(b.id) || 0).run();
      return json({ ok: true });
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

function json(data, status, req) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) }
  });
}

function corsHeaders(req) {
  const origin = req ? (req.headers.get('Origin') || '') : '';
  const allow = ['https://theslowtide.pages.dev', 'https://theslowtidefk.pages.dev', 'http://localhost', 'http://127.0.0.1', 'null'];
  const a = !origin ? '*' : (allow.includes(origin) ? origin : 'https://theslowtidefk.pages.dev');
  return {
    'Access-Control-Allow-Origin': a,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}
