// The add-account page: one self-contained HTML document (no framework, no external files). Script and style carry the nonce.
// All URLs in it are relative, because the server puts every route under a random path prefix.

/** Browser JS, also run by the tests: a gentle note when the address does not look like the chosen provider's. */
export const DOMAIN_CHECK = String.raw`function domainWarning(kind, address) {
  var d = (/@([^@\s]+\.[^@\s]+)$/.exec(address.trim()) || [])[1];
  if (!d) return '';
  d = d.toLowerCase();
  if (kind === 'google' && !/^(gmail|googlemail)\.com$/.test(d)) return "This doesn't look like a Gmail address. Check for a typo, or go ahead if it's a Google Workspace address.";
  if (kind === 'yahoo' && !/^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com|aol\.com)$/.test(d)) return "This doesn't look like a Yahoo address. Check for a typo.";
  return '';
}`;

const plainDoc = (nonce: string, body: string, script: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Add an account · multi-account-mcp</title><p id="m">${body}</p><noscript><p>This page needs JavaScript turned on.</p></noscript><script nonce="${nonce}">${script}</script></html>`;

/** Opened by the CLI: the launch token is in the fragment, posted once and then gone from the address bar. */
// A JS string literal that is safe inside <script>.
const jsStr = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const start = (nonce: string, cmd = 'multi-account-mcp') => plainDoc(nonce, 'Opening the setup page…', `(function () {
  var t = location.hash.slice(1), m = document.getElementById('m');
  history.replaceState(null, '', location.pathname);
  fetch('start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }), credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (r) { if (r.ok) location.replace('./'); else m.textContent = r.error; })
    .catch(function () { m.textContent = ${jsStr(`The setup page stopped. Run ${cmd} add again.`)}; });
})();`);

/** A same-site hop after a cross-site redirect, so the browser sends the SameSite=Strict cookie. */
export const bounce = (nonce: string) => plainDoc(nonce, 'Coming back to the setup page…',
  `location.replace(location.pathname + '?r=1' + location.hash);`);

// Provider logos, inline so the page needs no outside files. The Google "G" is only used on the Google sign-in button, per Google's branding rules.
const svg = (vb: string, body: string, size = 20) => `<svg width="${size}" height="${size}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const GOOGLE = svg('0 0 24 24', '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.56 10.56 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/>');
const GMAIL = svg('52 42 88 66', '<path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6"/><path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15"/><path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2"/><path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92"/><path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2"/>');
const MICROSOFT = svg('0 0 22 22', '<rect x="1" y="1" width="9.5" height="9.5" fill="#f25022"/><rect x="11.5" y="1" width="9.5" height="9.5" fill="#7fba00"/><rect x="1" y="11.5" width="9.5" height="9.5" fill="#00a4ef"/><rect x="11.5" y="11.5" width="9.5" height="9.5" fill="#ffb900"/>');
const YAHOO = svg('0 0 24 24', '<path fill="#6001d2" d="M18.86 1.56l-4.59 10.31h5.13L24 1.56h-5.14M0 6.71l5.15 11.56-1.85 4.17h4.53l6.86-15.73h-4.5l-2.8 6.73-2.77-6.73H0m15.62 6.16c-1.67 0-2.91 1.25-2.91 2.71 0 1.42 1.2 2.61 2.79 2.61 1.68 0 2.93-1.23 2.93-2.69 0-1.47-1.2-2.63-2.81-2.63z"/>');
const ICLOUD = svg('0 0 24 24', '<path fill="#3693f3" d="M13.76 4.29a6.51 6.51 0 0 0-5.67 3.33 3.57 3.57 0 0 0-5.07 2.64A4.92 4.92 0 0 0 0 14.8a4.92 4.92 0 0 0 5.54 4.87h14.42A4.6 4.6 0 0 0 24 15.08v-.01a4.59 4.59 0 0 0-3.73-4.5 6.51 6.51 0 0 0-6.51-6.28z"/>');
const MAIL = svg('0 0 24 24', '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>');
const LOGOS = { google: GMAIL, yahoo: YAHOO, icloud: ICLOUD, imap: MAIL };

export const page = (nonce: string, o: { csrf: string; google: boolean; microsoft: boolean; cmd?: string }) => String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="csrf" content="${o.csrf}">
<title>Add an account · multi-account-mcp</title>
<style nonce="${nonce}">
:root{--bg:#f6f6f4;--card:#fff;--text:#18181b;--muted:#6b6b70;--line:#8a8a84;--line-strong:#5f5f5a;--divider:#e4e4e2;--field:#fff;--primary:#18181b;--primary-text:#fff;--hover:#f4f4f2;--bad:#b3261e;--bad-bg:#fdecea;--good:#15803d;--good-bg:#e8f6ed;--focus:#2563eb;--warn:#7a4a00;--warn-bg:#fff4dc;--shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px -8px rgba(0,0,0,.10)}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--line:#7a7a72;--line-strong:#a1a1aa;--divider:#2c2c31;--field:#111113;--primary:#f4f4f5;--primary-text:#18181b;--hover:#222226;--bad:#ffb4ab;--bad-bg:#3b1a17;--good:#7fd89a;--good-bg:#12301d;--focus:#7aa2ff;--warn:#ffd38a;--warn-bg:#3a2a10;--shadow:0 1px 2px rgba(0,0,0,.5),0 12px 32px -8px rgba(0,0,0,.6)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:432px;margin:0 auto;padding:56px 16px}
.card{background:var(--card);border:1px solid var(--divider);border-radius:18px;padding:32px 28px;box-shadow:var(--shadow)}
.badge{width:44px;height:44px;border-radius:12px;border:1px solid var(--divider);display:grid;place-items:center;margin:0 auto 16px;color:var(--text)}
.center{text-align:center}
h1{font-size:1.3rem;letter-spacing:-.01em;margin:0 0 6px;line-height:1.3}
p{margin:0 0 16px}
.muted{color:var(--muted);font-size:.93rem}
.providers{display:grid;gap:10px;margin:24px 0 0}
button{font:inherit;cursor:pointer;border-radius:11px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:10px 16px;min-height:46px;transition:background .15s,border-color .15s}
button:hover{background:var(--hover);border-color:var(--line-strong)}
.provider{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;font-weight:550;position:relative}
.provider svg{flex:none;position:absolute;left:16px}
.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-text);font-weight:600;width:100%}
.primary:hover{background:var(--primary);opacity:.88}
.link{border:0;background:none;padding:2px 0;min-height:0;color:var(--muted);text-decoration:underline;text-underline-offset:3px;font-size:.9rem}
.link:hover{background:none;color:var(--text)}
.alt{text-align:center;margin-top:12px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button[disabled]{opacity:.6;cursor:progress}
.or{display:flex;align-items:center;gap:12px;margin:22px 0 14px;color:var(--muted);font-size:.78rem;letter-spacing:.06em;text-transform:uppercase}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--divider)}
.quick{display:grid;gap:10px}
label{display:block;font-weight:550;font-size:.9rem;margin:16px 0 6px}
.hint{color:var(--muted);font-weight:400}
input,select{font:inherit;width:100%;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--field);color:var(--text)}
input::placeholder{color:var(--muted);opacity:.8}
input:focus,select:focus{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 22%,transparent)}
.pw{position:relative}.pw input{padding-right:48px}
.pw button{position:absolute;right:4px;top:4px;min-height:0;height:36px;width:40px;padding:0;border:0;background:none;color:var(--muted);display:grid;place-items:center}
.pw button:hover{color:var(--text)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.head .logo{width:40px;height:40px;border-radius:11px;border:1px solid var(--divider);display:grid;place-items:center;flex:none}
.head h1{margin:0}
.back{border:0;background:none;min-height:0;padding:6px 8px 6px 0;margin:-8px 0 12px;color:var(--muted);display:inline-flex;align-items:center;gap:4px;font-size:.9rem}
.back:hover{background:none;color:var(--text)}
.help{background:var(--hover);border-radius:12px;padding:14px 16px;font-size:.9rem}
.help p{margin:0 0 10px;color:var(--muted)}
.help ol{margin:0;padding-left:20px}.help li{margin-bottom:4px}
.getpw{display:inline-flex;align-items:center;gap:6px;margin:0 0 10px;padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none;font-weight:550;font-size:.88rem}
.getpw:hover{border-color:var(--text)}
details{margin-top:16px}.adv{margin-top:10px}.adv summary{font-weight:400;color:var(--muted)}.full label{margin-top:10px}summary{cursor:pointer;font-weight:550;font-size:.9rem;color:var(--text)}summary .hint{margin-left:4px}
fieldset{border:1px solid var(--divider);border-radius:12px;margin:16px 0 0;padding:4px 14px 14px}
legend{font-weight:600;font-size:.9rem;padding:0 4px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.row>div:first-child{grid-column:1/-1}
.row label{margin-top:10px}
a{color:inherit}
.status{margin:14px 0 0;overflow-wrap:anywhere;font-size:.92rem}
.status.bad{color:var(--bad);background:var(--bad-bg);padding:10px 12px;border-radius:10px}
.status:empty,.note:empty{display:none}
.status.warn,.note{color:var(--warn);background:var(--warn-bg);padding:10px 12px;border-radius:10px}
.note{margin:8px 0 0;font-size:.9rem}
.actions{display:grid;gap:10px;margin-top:20px}
.check{width:52px;height:52px;border-radius:50%;background:var(--good-bg);color:var(--good);display:grid;place-items:center;margin:0 auto 14px}
code{font-size:.88em;background:var(--hover);padding:1px 5px;border-radius:5px}
[hidden]{display:none!important}
@media (max-width:440px){main{padding:24px 12px}.card{padding:24px 18px}}
</style>
</head>
<body>
<main>
<div class="card">

<section id="choose">
  <div class="badge">${svg('0 0 24 24', '<rect x="3" y="6" width="15" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 7.5l6.5 5 6.5-5M7 3.5h12a2 2 0 0 1 2 2V14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>')}</div>
  <div class="center">
    <h1>Add an email account</h1>
    <p class="muted">Connect each inbox you want your AI to see. You can add as many as you like.</p>
  </div>
  <div class="providers">
    ${o.google ? `<button class="provider" data-go="google">${GOOGLE}Continue with Google</button>` : `<button class="provider" data-go="google-password">${GMAIL}<span>Gmail</span></button>`}
    ${o.microsoft ? `<button class="provider" data-go="microsoft">${MICROSOFT}Continue with Microsoft</button>` : ''}
    <button class="provider" data-go="yahoo">${YAHOO}<span>Yahoo Mail</span></button>
    <button class="provider" data-go="icloud">${ICLOUD}<span>iCloud Mail</span></button>
    <button class="provider" data-go="imap">${MAIL}<span>Other email</span></button>
  </div>
  ${o.google ? '<div class="alt"><button class="link" data-go="google-password">Sign in to Gmail with an app password instead</button></div>' : ''}
  <div class="or">or</div>
  <form id="quickform" class="quick" novalidate>
    <input id="quick" type="email" autocomplete="email" placeholder="Type your email address" aria-label="Your email address">
    <button class="primary" type="submit">Continue</button>
  </form>
  <div class="status" id="choose-status" role="alert" aria-live="assertive"></div>
</section>

<section id="form" hidden>
  <button type="button" class="back" data-back>${svg('0 0 24 24', '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', 18)}Back</button>
  <div class="head"><div class="logo" id="form-logo"></div><h1 id="form-title"></h1></div>
  <div id="guide"></div>
  <form id="pwform" novalidate>
    <label for="address">Email address</label>
    <input id="address" name="address" type="email" autocomplete="email" required aria-describedby="addr-note" placeholder="you@example.com">
    <p class="note" id="addr-note" aria-live="polite"></p>
    <label for="password"><span id="pw-label">App password</span> <span class="hint" id="pw-hint"></span></label>
    <div class="pw"><input id="password" name="password" type="password" autocomplete="off" spellcheck="false" required><button type="button" id="toggle" aria-controls="password" aria-pressed="false" aria-label="Show password">${svg('0 0 24 24', '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/>', 18)}</button></div>
    <details id="servers" hidden><summary>Server settings <span class="hint" id="servers-hint">filled in for you</span></summary>
      <fieldset><legend>Incoming mail</legend><div>
        <div class="full"><label for="imap-host">Server name</label><input id="imap-host" autocomplete="off" placeholder="mail.example.com"></div>
        <details class="adv"><summary>Port and security <span class="hint">usually leave as is</span></summary><div class="row"><div><label for="imap-port">Port</label><input id="imap-port" inputmode="numeric" value="993"></div>
        <div><label for="imap-secure">Security</label><select id="imap-secure"><option value="true">SSL/TLS</option><option value="false">STARTTLS</option></select></div></div></details>
      </div></fieldset>
      <fieldset><legend>Outgoing mail</legend><div>
        <div class="full"><label for="smtp-host">Server name</label><input id="smtp-host" autocomplete="off" placeholder="mail.example.com"></div>
        <details class="adv"><summary>Port and security <span class="hint">usually leave as is</span></summary><div class="row"><div><label for="smtp-port">Port</label><input id="smtp-port" inputmode="numeric" value="465"></div>
        <div><label for="smtp-secure">Security</label><select id="smtp-secure"><option value="true">SSL/TLS</option><option value="false">STARTTLS</option></select></div></div></details>
      </div></fieldset>
    </details>
    <label for="label">Name <span class="hint">optional, shown to your AI</span></label>
    <input id="label" name="label" maxlength="100" autocomplete="off" placeholder="Personal, Projects, Shopping…">
    <div class="status" id="form-status" role="status" aria-live="polite"></div>
    <div class="actions"><button class="primary" type="submit">Connect</button><button type="button" class="stop" hidden>Cancel</button></div>
  </form>
</section>

<section id="oauth" hidden>
  <div class="head"><div class="logo">${GOOGLE}</div><h1>Signed in</h1></div>
  <p class="muted">Signed in as <strong id="oauth-address"></strong>.</p>
  <form id="oauthform" novalidate>
    <label for="oauth-label">Name <span class="hint">optional, shown to your AI</span></label>
    <input id="oauth-label" maxlength="100" autocomplete="off" placeholder="Personal, Projects, Shopping…">
    <div class="status" id="oauth-status" role="status" aria-live="polite"></div>
    <div class="actions"><button class="primary" type="submit">Connect</button><button type="button" class="stop" hidden>Stop checking</button><button type="button" data-back id="oauth-cancel">Cancel</button></div>
  </form>
</section>

<section id="ok" hidden>
  <div class="check">${svg('0 0 24 24', '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>', 26)}</div>
  <div class="center">
    <h1 id="ok-title" tabindex="-1"></h1>
    <p class="muted">Your AI can now search and read this inbox. Sending stays off until you turn it on with <code>${escHtml(o.cmd ?? 'multi-account-mcp')} allow-send</code>.</p>
  </div>
  <p class="status warn" id="ok-warn" role="status"></p>
  <div class="actions"><button class="primary" data-back>Add another account</button><button id="done">Done</button></div>
</section>

<section id="bye" hidden>
  <div class="check">${svg('0 0 24 24', '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>', 26)}</div>
  <div class="center">
    <h1 tabindex="-1">All set</h1>
    <p class="muted">You can close this tab. If your AI tool was already open, restart it.</p>
  </div>
</section>

</div>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var kind = '', sendKind = '', flowId = '', presetFilled = true;
  var LOGOS = ${jsStr(JSON.stringify(LOGOS))};
  LOGOS = JSON.parse(LOGOS);
  var OPEN = function (url, name) { return '<a class="getpw" href="' + url + '" target="_blank" rel="noopener noreferrer">' + name + ' &#8599;</a>'; };
  var GUIDES = {
    google: ['Gmail', '<div class="help"><p>Gmail needs a password made just for apps. Your normal password stays private, and you can delete this one any time.</p>' + OPEN('https://myaccount.google.com/apppasswords', 'Get one from Google') + '<ol><li>Turn on 2-Step Verification if Google asks.</li><li>Name it "multi-account-mcp" and click Create.</li><li>Copy the 16-letter password and paste it below.</li></ol></div>'],
    yahoo: ['Yahoo Mail', '<div class="help"><p>Yahoo needs a password made just for apps. Your normal password stays private, and you can delete this one any time.</p>' + OPEN('https://login.yahoo.com/account/security', 'Get one from Yahoo') + '<ol><li>Click "Generate app password".</li><li>Name it "multi-account-mcp" and click Generate.</li><li>Copy the password and paste it below.</li></ol></div>'],
    icloud: ['iCloud Mail', '<div class="help"><p>iCloud needs a password made just for apps. Your Apple Account password stays private.</p>' + OPEN('https://account.apple.com', 'Get one from Apple') + '<ol><li>Open Sign-In and Security, then App-Specific Passwords.</li><li>Name it "multi-account-mcp" and create it.</li><li>Copy the password and paste it below.</li></ol></div>'],
    imap: ['Other email', '<div class="help"><p>Use the password your provider gives for mail apps. Server settings are looked up for you from your address.</p></div>']
  };
  var CSRF = document.querySelector('meta[name=csrf]').content, ctrl = null;
  ${DOMAIN_CHECK}

  function show(id) {
    ['choose', 'form', 'oauth', 'ok', 'bye'].forEach(function (s) { $(s).hidden = s !== id; });
  }
  function say(el, text, bad) { el.textContent = text || ''; el.className = 'status' + (bad ? ' bad' : ''); }
  function api(path, body, signal) {
    return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF }, body: JSON.stringify(body), credentials: 'same-origin', signal: signal } : { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .catch(function () { return signal && signal.aborted ? { cancelled: true } : { error: ${jsStr(`The setup page stopped. Run ${o.cmd ?? 'multi-account-mcp'} add again.`)} }; });
  }
  function busy(form, on) {
    var b = form.querySelector('.primary');
    b.disabled = on; b.textContent = on ? 'Connecting…' : 'Connect';
    form.querySelector('.stop').hidden = !on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  // Runs one connection check; the form's Cancel aborts it and keeps what was typed.
  function check(form, st, path, body) {
    ctrl = new AbortController();
    busy(form, true); say(st, 'Checking the connection…');
    api(path, body, ctrl.signal).then(function (r) {
      busy(form, false);
      if (r.cancelled) say(st, 'Cancelled. Nothing was saved.');
      else if (r.ok) connected(r); else say(st, r.error, true);
    });
  }
  document.querySelectorAll('.stop').forEach(function (b) { b.addEventListener('click', function () { if (ctrl) ctrl.abort(); }); });
  function connected(r) {
    $('ok-title').textContent = (r.again ? 'Signed in to ' : 'Connected ') + r.label;
    $('ok-warn').textContent = r.warning || '';
    show('ok'); $('ok-title').focus();
    $('pwform').reset(); presetFilled = true;
  }
  function fillServers(address) {
    if (kind === 'imap') $('servers-hint').textContent = 'looking them up…';
    var asked = kind === 'icloud' ? '' : address;
    return api('api/preset?address=' + encodeURIComponent(address)).then(function (p) {
      if (asked && ($('address').value !== asked || !presetFilled)) return;
      if (kind === 'imap') {
        $('servers').open = !p.imap;
        $('servers-hint').textContent = p.imap ? 'filled in for you' : "couldn't find them, enter them from your provider's help page";
      }
      if (!p.imap) return;
      ['imap', 'smtp'].forEach(function (s) {
        $(s + '-host').value = p[s].host; $(s + '-port').value = p[s].port; $(s + '-secure').value = String(p[s].secure);
      });
    });
  }

  function open(k, address) {
    say($('choose-status'), '');
    if (k === 'google' || k === 'microsoft') { location.href = 'oauth/start?provider=' + k; return; }
    kind = k === 'google-password' ? 'google' : k;
    sendKind = kind === 'icloud' ? 'imap' : kind;
    $('form-title').textContent = GUIDES[kind][0];
    $('form-logo').innerHTML = LOGOS[kind];
    $('guide').innerHTML = GUIDES[kind][1];
    $('servers').hidden = kind !== 'imap'; $('servers').open = false; $('servers-hint').textContent = 'filled in once you enter your address';
    ['imap', 'smtp'].forEach(function (x) { $(x + '-host').value = ''; }); $('imap-port').value = '993'; $('smtp-port').value = '465'; $('imap-secure').value = $('smtp-secure').value = 'true'; presetFilled = true;
    $('pw-label').textContent = kind === 'imap' ? 'Password' : 'App password';
    $('pw-hint').textContent = kind === 'imap' ? 'the one your provider gives for mail apps' : '';
    if (kind === 'icloud') fillServers('me@icloud.com');
    $('address').value = address || '';
    say($('form-status'), ''); note();
    show('form');
    if (address) { if (kind === 'imap') fillServers(address); $('password').focus(); } else $('address').focus();
  }

  // Type-your-email: pick the provider from the address.
  $('quickform').addEventListener('submit', function (e) {
    e.preventDefault();
    var a = $('quick').value.trim(), d = ((/@([^@\s]+\.[^@\s]+)$/.exec(a) || [])[1] || '').toLowerCase();
    if (!d) { say($('choose-status'), 'Enter your full email address, like you@example.com.', true); return; }
    if (/^(gmail|googlemail)\.com$/.test(d)) return open(${o.google ? "'google'" : "'google-password'"}, a);
    if (/^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/.test(d)) return open('yahoo', a);
    if (/^(icloud|me|mac)\.com$/.test(d)) return open('icloud', a);
    if (/^(outlook|hotmail|live|msn)\\.[a-z.]+$/.test(d)) { ${o.microsoft ? "return open('microsoft');" : "say($('choose-status'), \"Outlook and Hotmail accounts aren't supported yet. They only allow their own sign-in, which isn't set up here.\", true); return;"} }
    open('imap', a);
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-back]');
    if (!t) return;
    if (t.id === 'oauth-cancel' && flowId) { api('api/flow/' + flowId + '/cancel', {}); flowId = ''; }
    if (t.hasAttribute('data-back')) { show('choose'); document.querySelector('.provider').focus(); return; }
    open(t.getAttribute('data-go'));
  });

  $('toggle').addEventListener('click', function () {
    var p = $('password'), on = p.type === 'password';
    p.type = on ? 'text' : 'password';
    this.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    this.setAttribute('aria-pressed', String(on));
  });

  function note() { $('addr-note').textContent = domainWarning(kind, $('address').value); }
  $('address').addEventListener('input', function () { if ($('addr-note').textContent) note(); });
  $('address').addEventListener('change', function () {
    note();
    if (kind === 'imap' && presetFilled) fillServers(this.value);
  });
  ['imap-host', 'smtp-host', 'imap-port', 'smtp-port'].forEach(function (id) {
    $(id).addEventListener('input', function () { presetFilled = false; });
  });

  $('pwform').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this, st = $('form-status');
    note();
    if (!$('address').value.trim() || !$('password').value) { say(st, 'Enter your email address and password.', true); return; }
    var ep = function (s) { return { host: $(s + '-host').value, port: $(s + '-port').value, secure: $(s + '-secure').value === 'true' }; };
    var body = { kind: sendKind, address: $('address').value, password: $('password').value, label: $('label').value };
    if (sendKind === 'imap') { body.imap = ep('imap'); body.smtp = ep('smtp'); if (!body.imap.host || !body.smtp.host) { $('servers').open = true; say(st, 'Enter the incoming and outgoing server names. Your provider\u2019s help page lists them.', true); $(body.imap.host ? 'smtp-host' : 'imap-host').focus(); return; } }
    check(form, st, 'api/password', body);
  });

  $('oauthform').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this, st = $('oauth-status');
    check(form, st, 'api/flow/' + flowId, { label: $('oauth-label').value });
  });

  $('done').addEventListener('click', function () {
    api('api/done', {}).then(function () { show('bye'); document.querySelector('#bye h1').focus(); });
  });

  var m = /^#flow=([\w-]+)$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    flowId = m[1];
    api('api/flow/' + flowId).then(function (f) {
      if (f.status === 'ready') {
        $('oauth-address').textContent = f.address; $('oauth-label').value = f.label || '';
        show('oauth'); $('oauth-label').focus();
      } else say($('choose-status'), f.error || 'Sign-in did not finish. Try again.', true);
    });
  }
})();
</script>
</body>
</html>`;
