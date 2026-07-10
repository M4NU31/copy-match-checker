// Cloudflare Pages Function: proxies /api/* to the backend (serve.py on the VPS).
//
// The browser only ever talks to this Pages origin over HTTPS (same-origin, no
// CORS, no mixed content). This edge function forwards the request server-side
// to the backend over plain HTTP and injects the shared secret, so the backend
// needs no TLS/domain and the Claude key can't be spent by hitting the VPS IP.
//
// Project env vars (Cloudflare Pages -> Settings -> Environment variables):
//   BACKEND_URL   e.g. http://191.101.235.160   (no trailing slash, no /api)
//   PROXY_SECRET  must match PROXY_SECRET in the backend .env
//
// Path mapping: /api/render        -> BACKEND_URL/render
//               /api/ai/compare    -> BACKEND_URL/ai/compare
//               /api/ai/segment-pages -> BACKEND_URL/ai/segment-pages
export async function onRequest(context) {
  const { request, env, params } = context;

  if (!env.BACKEND_URL || !env.PROXY_SECRET) {
    return new Response(
      JSON.stringify({ error: "Proxy not configured: set BACKEND_URL and PROXY_SECRET" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const segs = params.path; // wildcard after /api/
  const path = Array.isArray(segs) ? segs.join("/") : (segs || "");
  const search = new URL(request.url).search;
  const target = env.BACKEND_URL.replace(/\/+$/, "") + "/" + path + search;

  // Only forward what the backend needs; never trust a client-sent secret.
  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("X-Proxy-Secret", env.PROXY_SECRET);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  try {
    return await fetch(target, init);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Backend unreachable: " + (e && e.message ? e.message : String(e)) }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
