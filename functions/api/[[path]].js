// Cloudflare Pages Functions - The Slow Tide 官网 API 代理
// /api/auth/* -> Supabase Auth；/api/rest/* -> Supabase REST
// /api/data、/api/admin -> 转发到数据服务站点（解决前端写死域名问题，K27JL4）
// CORS 仅放行本站与反馈站（299K8H）

const SUPABASE_URL = 'https://jilcbcodphxpasicjghv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppbGNiY29kcGh4cGFzaWNqZ2h2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MDUzNTgsImV4cCI6MjEwNDE4MTM1OH0._DkyiWyL5viXByCJ5ejFifn9RuEVkVHjAnU4oQepsbs';
const DATA_ORIGIN = 'https://tst-server-site.pages.dev';

function allowedOrigin(req) {
  const origin = req.headers.get('Origin') || '';
  const ok = ['https://theslowtide.pages.dev', 'https://theslowtidefk.pages.dev', 'http://localhost', 'http://127.0.0.1', 'null'];
  return ok.includes(origin) ? origin : '';
}
function corsHeaders(req) {
  const origin = allowedOrigin(req);
  return {
    'Access-Control-Allow-Origin': origin || 'https://theslowtide.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

async function proxyFetch(target, request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, { method: request.method, headers: headers, body: body, redirect: 'manual' });
  const respHeaders = new Headers(upstream.headers);
  respHeaders.set('Access-Control-Allow-Origin', allowedOrigin(request) || 'https://theslowtide.pages.dev');
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request) });
  }

  // 数据/管理接口：转发到数据服务站点（同域化，前端不再写死域名）
  if (path === '/api/data' || path.startsWith('/api/data/')) {
    return proxyFetch(DATA_ORIGIN + '/api/data' + url.search, request);
  }
  if (path === '/api/admin' || path.startsWith('/api/admin/')) {
    return proxyFetch(DATA_ORIGIN + '/api/admin' + url.search, request);
  }

  // 仅代理 /api/auth/* 与 /api/rest/*
  if (path.startsWith('/api/auth/') || path.startsWith('/api/rest/')) {
    let target;
    if (path.startsWith('/api/rest/')) {
      target = SUPABASE_URL + '/rest/v1' + path.slice('/api/rest'.length) + url.search;
    } else {
      target = SUPABASE_URL + '/auth/v1' + path.slice('/api/auth'.length) + url.search;
    }
    const headers = new Headers(request.headers);
    headers.delete('host');
    if (!headers.get('apikey')) headers.set('apikey', SUPABASE_ANON);
    if (!headers.get('authorization')) headers.set('authorization', 'Bearer ' + SUPABASE_ANON);

    let body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    // 活动参与落库时注入真实客户端 IP（防多账号重复领取）
    if (request.method === 'POST' && path.includes('/activity_participants') && body && body.byteLength) {
      try {
        const obj = JSON.parse(new TextDecoder().decode(body));
        const cfIp = request.headers.get('CF-Connecting-IP') || '';
        if (!obj.ip) obj.ip = cfIp;
        body = new TextEncoder().encode(JSON.stringify(obj));
      } catch (e) { /* 非 JSON 原样转发 */ }
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers: headers,
      body: body,
      redirect: 'manual'
    });
    const respHeaders = new Headers(upstream.headers);
    respHeaders.set('Access-Control-Allow-Origin', allowedOrigin(request) || 'https://theslowtide.pages.dev');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders
    });
  }

  return new Response('Not found', { status: 404 });
}
