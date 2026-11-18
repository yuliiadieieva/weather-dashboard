// Password gate for the Andrews Sykes Weather Dashboard (one Worker per site: ASG, UK, Europe, Middle East).
// The password lives only in the Worker's encrypted secret PASSWORD (Cloudflare dashboard, Settings > Variables and Secrets).
// Every request, including static files, passes through here first (assets.run_worker_first), so nothing is served without a session.
import { LOGO } from "./logo.js";

const COOKIE = "wx_session";
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(s) { return crypto.subtle.digest("SHA-256", enc.encode(s)); }
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}
async function sign(env, msg) {
  // the key includes the password, so changing the password ends every existing session of this site
  const key = await crypto.subtle.importKey("raw", enc.encode(`wx|${env.SITE}|${env.PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeToken(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return `${exp}.${await sign(env, `${env.SITE}|${exp}`)}`;
}
async function validToken(env, tok) {
  if (!tok || !env.PASSWORD) return false;
  const [exp, sig] = tok.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || +exp < Date.now() / 1000) return false;
  const good = await sign(env, `${env.SITE}|${exp}`);
  return good.length === sig.length && crypto.subtle.timingSafeEqual(enc.encode(good), enc.encode(sig));
}
const getCookie = (req, name) => {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
};
const cookie = (val, maxAge) => `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const SEC = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
const withSec = (res, extra = {}) => {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SEC, ...extra })) r.headers.set(k, v);
  return r;
};
const redirect = (to, extra = {}) => new Response(null, { status: 303, headers: { Location: to, ...SEC, ...extra } });

// failed-attempt counter per visitor address (Durable Object, survives across Cloudflare locations)
export class Limiter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const op = new URL(req.url).pathname;
    const now = Date.now() / 1000;
    let rec = (await this.state.storage.get("r")) || { n: 0, until: 0, first: now };
    if (rec.until && rec.until < now) rec = { n: 0, until: 0, first: now };
    if (op === "/fail") {
      rec.n += 1;
      if (rec.n >= MAX_FAILS) rec.until = now + LOCK_SECONDS;
      await this.state.storage.put("r", rec);
    } else if (op === "/reset") {
      await this.state.storage.delete("r");
      rec = { n: 0, until: 0 };
    }
    return Response.json({ locked: rec.until > now, n: rec.n });
  }
}
async function limiter(env, req, op) {
  if (!env.LIMITER) return { locked: false };
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const stub = env.LIMITER.get(env.LIMITER.idFromName(`${env.SITE}|${ip}`));
  return (await stub.fetch(`https://limiter/${op}`)).json();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function page(env, { error = "", note = "", status = 200 } = {}) {
  const title = env.TITLE || "";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Weather Dashboard ${esc(title)} · Sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{font-family:Inter,system-ui,"Segoe UI",Arial,sans-serif;background:#0b1424;color:#e6edf7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{width:100%;max-width:420px;border-radius:20px;overflow:hidden;background:#111d31;border:1px solid #1f2f4a;box-shadow:0 20px 50px rgba(0,0,0,.4)}
.top{background:linear-gradient(135deg,#0d2a57,#1d4f99 60%,#3f7fd0);padding:26px 28px}.top svg{max-width:200px;height:auto}
h1{font-size:22px;margin:16px 0 4px;font-weight:600}h1 b{font-weight:800}.top p{margin:0;color:#c9d8ee;font-size:13px}
form{padding:24px 28px 28px}label{font-size:13px;color:#a9bbd3;display:block;margin-bottom:6px}
.in{display:flex;align-items:center;background:#0b1424;border:1px solid #2a3d5e;border-radius:10px;padding:0 6px 0 12px;height:44px}
.in:focus-within{border-color:#3b8fe8}.in.err{border-color:#E5484D}
input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:#e6edf7;font:inherit;font-size:15px;height:100%}
.eye{background:none;border:0;cursor:pointer;padding:6px;color:#a9bbd3;display:flex}.eye svg{width:18px;height:18px}
.msg{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:#ff8a8d}.msg svg{flex:none}
button.go{width:100%;margin-top:18px;height:44px;border-radius:10px;background:#3b8fe8;color:#fff;font-weight:600;font-size:15px;border:0;cursor:pointer}
button.go:hover{background:#2f7fd6}button.go:disabled{opacity:.5;cursor:not-allowed}
.foot{margin-top:16px;font-size:12px;color:#7d92ae;line-height:1.5}
</style></head><body><main class="card"><div class="top">${LOGO}<h1>Weather Dashboard <b>${esc(title)}</b></h1><p>${esc(env.SUBTITLE || "")}</p></div>
<form method="post" action="/login" autocomplete="on"><label for="pw">Password</label>
<div class="in${error ? " err" : ""}"><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus ${note ? "disabled" : ""}>
<button class="eye" type="button" aria-label="Show password" onclick="var i=document.getElementById('pw');i.type=i.type==='password'?'text':'password'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
${error || note ? `<div class="msg" role="alert"><svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#E5484D"/><path d="M12 7v6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/></svg>${esc(error || note)}</div>` : ""}
<button class="go" type="submit" ${note ? "disabled" : ""}>Sign in</button>
<div class="foot">You stay signed in on this device for ${SESSION_DAYS} days.<br>No access? Contact Yuliia Dieieva, Marketing.</div></form></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...SEC,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/favicon.svg" || p === "/favicon-32.png" || p === "/favicon-180.png" || p === "/robots.txt") {
      return withSec(await env.ASSETS.fetch(req));
    }
    if (p === "/logout") return redirect("/login", { "Set-Cookie": cookie("", 0) });
    if (p === "/login") {
      if (!env.PASSWORD) return page(env, { note: "This site is not set up yet.", status: 503 });
      if (req.method === "POST") {
        const lim = await limiter(env, req, "check");
        if (lim.locked) return page(env, { error: "Too many attempts. Please try again in 15 minutes.", status: 429 });
        const form = await req.formData().catch(() => null);
        const pw = (form && form.get("password")) || "";
        if (pw && (await sameSecret(String(pw), env.PASSWORD))) {
          await limiter(env, req, "reset");
          return redirect("/", { "Set-Cookie": cookie(await makeToken(env), SESSION_DAYS * 86400) });
        }
        const after = await limiter(env, req, "fail");
        await new Promise((r) => setTimeout(r, 400));
        return page(env, { error: after.locked ? "Too many attempts. Please try again in 15 minutes." : "Incorrect password. Please try again.", status: 401 });
      }
      if (await validToken(env, getCookie(req, COOKIE))) return redirect("/");
      return page(env);
    }
    if (!(await validToken(env, getCookie(req, COOKIE)))) {
      const wantsPage = req.method === "GET" && (req.headers.get("Accept") || "").includes("text/html");
      return wantsPage ? redirect("/login") : new Response("Sign in required", { status: 401, headers: SEC });
    }
    return withSec(await env.ASSETS.fetch(req));
  },
};
