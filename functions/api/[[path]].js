// Cloudflare Pages Functions - Supabase API 代理
// 文件路径：functions/api/[[path]].js
// 把 /api/* 的请求转发到 Supabase，解决国内 supabase.co 域名访问问题
const SUPABASE_URL = 'https://jilbcodphxpasicjghv.supabase.co';

export async function onRequest(context) {
  const { request } = context;

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  // /api/rest/v1/Feedback -> /rest/v1/Feedback
  const path = url.pathname.replace(/^\/api/, '');
  const targetUrl = SUPABASE_URL + path + url.search;

  const headers = new Headers(request.headers);
  headers.set('host', new URL(SUPABASE_URL).host);

  const modifiedRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow',
  });

  const response = await fetch(modifiedRequest);
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
