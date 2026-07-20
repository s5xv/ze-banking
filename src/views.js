// views.js - shared rendering for Z&E Bank.
// Light/dark follows the OS by default and can be overridden with a toggle
// that persists in localStorage.

import { formatCents } from "./money.js";

export const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });

export const money = (cents) => formatCents(cents);

/**
 * The in game command a customer runs to pay the bank.
 *
 * Kept in one place because it appears on the deposit page, the verification
 * page, company pages and the admin funding panel. If the format or the
 * account name ever changes, every instruction on the site has to change with
 * it, or customers are handed a command that silently fails.
 *
 *   /pay-account business ZEB <amount> <memo>
 */
export const payCommand = (env, amount, memo) =>
  `/pay-account business ${env.BANK_ACCOUNT_NAME || "ZEB"} ${amount} ${memo}`;
export const shortDate = (s) => esc(String(s || "").slice(0, 16).replace("T", " "));

const THEME_SCRIPT = `<script>
(function(){
  try{
    var t = localStorage.getItem("ze_theme");
    if (t) document.documentElement.setAttribute("data-theme", t);
  }catch(e){}
  window.__toggleTheme = function(){
    var cur = document.documentElement.getAttribute("data-theme");
    var isDark = cur ? cur === "dark"
                     : matchMedia("(prefers-color-scheme: dark)").matches;
    var next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try{ localStorage.setItem("ze_theme", next); }catch(e){}
  };
})();
</script>`;

const STYLE = `<style>
  :root{
    --bg:#f7f9fc; --panel:#ffffff; --panel2:#f1f5f9; --line:#e2e8f0;
    --text:#0f172a; --muted:#64748b; --accent:#2563eb; --accent2:#1d4ed8;
    --good:#059669; --bad:#dc2626; --warn:#d97706; --shadow:0 1px 3px rgba(15,23,42,.08);
  }
  :root[data-theme="dark"]{
    --bg:#0b0d12; --panel:#141821; --panel2:#1b2130; --line:#252c3a;
    --text:#e9edf5; --muted:#94a3b8; --accent:#3b82f6; --accent2:#60a5fa;
    --good:#34d399; --bad:#f87171; --warn:#fbbf24; --shadow:none;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#0b0d12; --panel:#141821; --panel2:#1b2130; --line:#252c3a;
      --text:#e9edf5; --muted:#94a3b8; --accent:#3b82f6; --accent2:#60a5fa;
      --good:#34d399; --bad:#f87171; --warn:#fbbf24; --shadow:none;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);line-height:1.55;
    font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:980px;margin:0 auto;padding:0 20px}
  /* The header needs more room than the content column, otherwise six nav
     links plus the account controls wrap onto a second line. */
  .top .wrap{max-width:1180px}
  header.top{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20}
  .top .wrap{display:flex;align-items:center;gap:16px;min-height:60px}
  .brand{font-weight:800;font-size:18px;letter-spacing:-.3px;flex:none}
  .brand span{color:var(--accent)}
  .navpanel{display:flex;align-items:center;gap:16px;flex:1;min-width:0}
  .top nav{display:flex;gap:16px;flex-wrap:nowrap}
  .top nav a{color:var(--muted);font-weight:600;font-size:14px;white-space:nowrap}
  .top nav a:hover,.top nav a.on{color:var(--text)}
  .spacer{flex:1}
  /* Burger, pure CSS. Hidden until the links stop fitting. */
  #navtoggle{position:absolute;opacity:0;pointer-events:none}
  .burger{display:none}
  .iconbtn{background:none;border:1px solid var(--line);color:var(--muted);cursor:pointer;
    border-radius:8px;padding:6px 10px;font-size:14px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.4px}
  h2{font-size:18px;margin:0 0 10px}
  h3{font-size:15px;margin:0 0 8px}
  .muted{color:var(--muted)}
  .small{font-size:13px}
  section{padding:28px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:20px;box-shadow:var(--shadow)}
  .cards{display:grid;gap:16px}
  .c2{grid-template-columns:repeat(2,1fr)}
  .c3{grid-template-columns:repeat(3,1fr)}
  @media(max-width:760px){.c2,.c3{grid-template-columns:1fr}}
  .balance{font-size:32px;font-weight:800;letter-spacing:-1px;font-variant-numeric:tabular-nums}
  .acct-row{display:flex;justify-content:space-between;align-items:center;gap:14px;
    padding:14px 0;border-bottom:1px solid var(--line)}
  .acct-row:last-child{border-bottom:0}
  .btn{display:inline-block;background:var(--accent);color:#fff;font-weight:600;border:0;
    padding:11px 18px;border-radius:9px;cursor:pointer;font-size:14px;font-family:inherit}
  .btn:hover{background:var(--accent2)}
  .btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
  .btn.sm{padding:7px 12px;font-size:13px}
  .btn:disabled{opacity:.5;cursor:default}
  label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
  input,select{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);
    padding:11px 12px;border-radius:9px;font-size:15px;font-family:inherit}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .field{margin-bottom:16px}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--panel2);
    border:1px solid var(--line);padding:14px;border-radius:10px;font-size:15px;
    word-break:break-all;user-select:all}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
  td.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
  .pos{color:var(--good)}.neg{color:var(--bad)}
  .pill{display:inline-block;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;
    background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
  .pill.good{color:var(--good);border-color:var(--good)}
  .pill.bad{color:var(--bad);border-color:var(--bad)}
  .pill.warn{color:var(--warn);border-color:var(--warn)}
  .notice{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--panel);
    border-radius:10px;padding:14px 16px;margin:16px 0}
  .notice.bad{border-left-color:var(--bad)}
  .notice.good{border-left-color:var(--good)}
  .notice.warn{border-left-color:var(--warn)}
  .empty{color:var(--muted);text-align:center;padding:28px;border:1px dashed var(--line);border-radius:12px}
  footer{border-top:1px solid var(--line);color:var(--muted);font-size:13px;padding:24px 0;margin-top:40px}
  /* Below this the links no longer fit on one line, so collapse rather than
     wrap. Wrapping made the sticky header two rows tall with the brand
     floating in the middle of it. */
  @media(max-width:1000px){
    .top .wrap{flex-wrap:wrap;gap:0;padding-top:8px;padding-bottom:8px;min-height:0}
    .burger{display:flex;flex-direction:column;justify-content:center;gap:5px;
      margin-left:auto;cursor:pointer;padding:10px;flex:none}
    .burger span{display:block;width:22px;height:2px;background:var(--text);border-radius:2px}
    .navpanel{display:none;width:100%;flex-direction:column;align-items:stretch;gap:0}
    #navtoggle:checked ~ .navpanel{display:flex}
    .top nav{flex-direction:column;flex-wrap:nowrap;width:100%;gap:0}
    .top nav a{padding:13px 2px;border-top:1px solid var(--line);font-size:15px}
    .navpanel .spacer{display:none}
    .navpanel .iconbtn,.navpanel .btn{margin:10px 0 4px;align-self:flex-start}
  }
  @media(max-width:640px){
    h1{font-size:22px}
    .balance{font-size:26px}
    .card{padding:16px}
    .cards.c2,.cards.c3{grid-template-columns:1fr}
  }
</style>`;

export function layout(title, body, { user = null, active = "" } = {}) {
  const inner = user
    ? `<nav>
         <a href="/app" class="${active === "home" ? "on" : ""}">Accounts</a>
         <a href="/app/deposit" class="${active === "deposit" ? "on" : ""}">Deposit</a>
         <a href="/app/withdraw" class="${active === "withdraw" ? "on" : ""}">Withdraw</a>
         <a href="/app/transfer" class="${active === "transfer" ? "on" : ""}">Transfer</a>
         <a href="/app/savings" class="${active === "savings" ? "on" : ""}">Deposits</a>
         <a href="/app/scheduled" class="${active === "scheduled" ? "on" : ""}">Scheduled</a>
         <a href="/app/business" class="${active === "business" ? "on" : ""}">Companies</a>
         ${user.role !== "customer" ? `<a href="/admin" class="${active === "admin" ? "on" : ""}">Admin</a>` : ""}
       </nav>
       <div class="spacer"></div>
       <button class="iconbtn" onclick="__toggleTheme()" title="Light / dark">◐</button>
       <a class="btn ghost sm" href="/auth/logout">Log out</a>`
    : `<nav></nav>
       <div class="spacer"></div>
       <button class="iconbtn" onclick="__toggleTheme()" title="Light / dark">◐</button>
       <a class="btn sm" href="/auth/login">Log in with Discord</a>`;

  const nav = `<input type="checkbox" id="navtoggle" aria-label="Toggle menu">
    <label class="burger" for="navtoggle"><span></span><span></span><span></span></label>
    <div class="navpanel">${inner}</div>`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Z&amp;E Bank</title>
${THEME_SCRIPT}${STYLE}</head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">Z&amp;E<span> Bank</span></a>
  ${nav}
</div></header>
<div class="wrap">${body}</div>
<footer><div class="wrap">Z&amp;E Bank · DemocracyCraft · Balances are held in the bank's Treasury account.</div></footer>
</body></html>`;
}

/** Signed amount, coloured and with an explicit + or -. */
export function signedMoney(cents) {
  const cls = cents < 0 ? "neg" : "pos";
  const sign = cents > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${money(cents)}</span>`;
}

export function notice(text, kind = "") {
  return `<div class="notice ${kind}">${text}</div>`;
}
