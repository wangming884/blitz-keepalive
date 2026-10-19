#!/usr/bin/env node
/**
 * Local stand-in for a blitz.cloud free-plan app, used to verify keepalive.mjs
 * without touching production. Mimics the behaviour documented at
 * https://blitz.cloud/docs/limits/ (sleeping apps):
 *
 *  - a browser navigation wakes the app, but the first answer may be a
 *    "waking" page that reloads itself once the app is ready;
 *  - a program request (no Sec-Fetch-Mode: navigate) gets an "asleep" answer
 *    and does NOT wake the app.
 *
 * Usage: node test/fake-blitz.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8787);
const bind = process.env.BIND ?? '127.0.0.1';
const SLEEP_AFTER_MS = Number(process.env.SLEEP_AFTER_MS ?? 8000);
const WAKE_DELAY_MS = Number(process.env.WAKE_DELAY_MS ?? 2000);
const APP_PASSWORD = process.env.APP_PASSWORD ?? '';
const SESSION_COOKIE = 'fake_session=authenticated';
const MAX_FORM_BYTES = 4 * 1024;
const LOGIN_REDIRECT_STATUS = Number(process.env.LOGIN_REDIRECT_STATUS ?? 303);

let lastBrowserVisit = 0;
let state = 'sleeping'; // sleeping | waking | online
const gatewayOnceSeen = new Map();

const wakePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Waking up</title>
<meta http-equiv="refresh" content="${Math.ceil(WAKE_DELAY_MS / 1000)}">
</head>
<body><h1>This app is asleep</h1>
<p>Waking it up, the page reloads by itself once the app is ready.</p></body></html>`;

const appPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo app</title></head>
<body><h1>Demo app is online</h1><p>Served by the simulated app container.</p></body></html>`;

function loginPage(errorMessage = '') {
  const error = errorMessage
    ? `<p role="alert" style="color:#b42318">${errorMessage}</p>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo app login</title></head>
<body>
  <main>
    <h1>Demo app password</h1>
    ${error}
    <form method="post" action="/">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body></html>`;
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function isAuthenticated(req) {
  return APP_PASSWORD !== '' && parseCookies(req.headers.cookie).get('fake_session') === 'authenticated';
}

function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function gatewayErrorPage(status) {
  const labels = {
    502: '502 Bad Gateway',
    503: '503 Service Unavailable',
    504: '504 Gateway Timeout',
  };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${labels[status]}</title></head>
<body><h1>${labels[status]}</h1><p>The simulated gateway is not ready.</p></body></html>`;
}

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_FORM_BYTES) {
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('form body too large'), { statusCode: 413 }));
      } else {
        resolve(body);
      }
    });
    req.on('error', reject);
  });
}

createServer((req, res) => {
  if (process.env.DEBUG_HEADERS) {
    console.log(
      JSON.stringify({
        url: req.url,
        mode: req.headers['sec-fetch-mode'] ?? null,
        dest: req.headers['sec-fetch-dest'] ?? null,
        ua: String(req.headers['user-agent'] ?? '').slice(0, 60),
      }),
    );
  }
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  const gateway = requestUrl.searchParams.get('gateway');
  const gatewayStatus = Number(String(gateway ?? '').replace(/-once$/, ''));
  if ([502, 503, 504].includes(gatewayStatus)) {
    if (gateway?.endsWith('-once')) {
      const key = requestUrl.pathname + requestUrl.search;
      const seen = gatewayOnceSeen.get(key) ?? 0;
      if (seen === 0) {
        gatewayOnceSeen.set(key, 1);
        sendHtml(res, gatewayStatus, gatewayErrorPage(gatewayStatus));
        return;
      }
    } else {
      sendHtml(res, gatewayStatus, gatewayErrorPage(gatewayStatus));
      return;
    }
  }

  if (requestUrl.searchParams.get('errorBody') === '503') {
    sendHtml(res, 200, gatewayErrorPage(503));
    return;
  }

  const mode = req.headers['sec-fetch-mode'];
  const ua = String(req.headers['user-agent'] ?? '');
  // Chrome sends Sec-Fetch-* only to trustworthy origins, so a plain-HTTP test
  // origin (this simulator) has to fall back to the header set that only a
  // browser navigation adds. Real blitz.cloud apps are HTTPS and always carry
  // Sec-Fetch-Mode: navigate.
  const isBrowserNavigation =
    /Mozilla\/5\.0/.test(ua) &&
    (mode === 'navigate' || (mode === undefined && req.headers['upgrade-insecure-requests'] === '1'));

  if (!isBrowserNavigation) {
    // Programs never wake a sleeping free app.
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('App is asleep. Requests from programs do not wake it.\n');
    return;
  }

  const idleMs = Date.now() - lastBrowserVisit;
  lastBrowserVisit = Date.now();
  if (state === 'online' && idleMs > SLEEP_AFTER_MS) state = 'sleeping';

  if (state === 'online') {
    if (!APP_PASSWORD || isAuthenticated(req)) {
      sendHtml(res, 200, appPage);
      return;
    }

    if (req.method === 'POST' && req.url === '/') {
      readFormBody(req)
        .then((body) => {
          const password = new URLSearchParams(body).get('password') ?? '';
          if (password !== APP_PASSWORD) {
            sendHtml(res, 401, loginPage('Incorrect password.'));
            return;
          }
          if ([502, 503, 504].includes(LOGIN_REDIRECT_STATUS)) {
            sendHtml(res, LOGIN_REDIRECT_STATUS, gatewayErrorPage(LOGIN_REDIRECT_STATUS), {
              'set-cookie': `${SESSION_COOKIE}; HttpOnly; Path=/; SameSite=Strict`,
            });
          } else {
            sendHtml(res, 303, '', {
              location: '/',
              'set-cookie': `${SESSION_COOKIE}; HttpOnly; Path=/; SameSite=Strict`,
            });
          }
        })
        .catch((error) => {
          const status = error.statusCode === 413 ? 413 : 400;
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(status === 413 ? 'Form body too large.\n' : 'Bad request.\n');
        });
      return;
    }

    sendHtml(res, 200, loginPage());
    return;
  }

  if (state === 'sleeping') {
    state = 'waking';
    setTimeout(() => {
      state = 'online';
    }, WAKE_DELAY_MS);
    sendHtml(res, 200, wakePage);
    return;
  }

  // waking: still serve the wake page, the meta refresh will come back.
  sendHtml(res, 200, wakePage);
}).listen(port, bind, () => {
  console.log(`fake blitz app on http://${bind}:${port} (sleeps after ${SLEEP_AFTER_MS}ms)`);
});
