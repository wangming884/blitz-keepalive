#!/usr/bin/env node
/**
 * Minimal proxy used only by the test suite.
 *
 *   MODE=http  node test/fake-proxy.mjs <port>   # HTTP proxy, optional Basic auth
 *   MODE=socks node test/fake-proxy.mjs <port>   # SOCKS5 proxy, no auth
 *
 * Optional env:
 *   PROXY_AUTH=user:pass  require Proxy-Authorization on the HTTP proxy
 *
 * Every proxied request is printed as one JSON line so tests can assert that
 * Chrome really went through the proxy.
 */
import http from 'node:http';
import net from 'node:net';

const mode = process.env.MODE === 'socks' ? 'socks' : 'http';
const port = Number(process.argv[2] ?? 8870);
const proxyAuth = process.env.PROXY_AUTH ?? '';

function log(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), mode, ...entry }));
}

function authorized(req) {
  if (!proxyAuth) return true;
  const expected = `Basic ${Buffer.from(proxyAuth).toString('base64')}`;
  return req.headers['proxy-authorization'] === expected;
}

function startHttpProxy() {
  const server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake-proxy"' });
      res.end('proxy auth required');
      return;
    }
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('absolute-form request expected');
      return;
    }
    log({ proto: 'http', method: req.method, url: req.url, authenticated: Boolean(proxyAuth) });

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, socket, head) => {
    if (!authorized(req)) {
      socket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake-proxy"\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    const [host, portRaw] = String(req.url).split(':');
    const targetPort = Number(portRaw);
    log({ proto: 'connect', host, port: targetPort, authenticated: Boolean(proxyAuth) });

    const upstream = net.connect(targetPort, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(port, '127.0.0.1', () => log({ event: 'listen', port }));
}

function startSocksProxy() {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (stage === 'greeting') {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        if (buffer[0] !== 5) {
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(2 + methods);
        // No authentication, regardless of the offered methods.
        socket.write(Buffer.from([5, 0]));
        stage = 'request';
      }

      if (stage !== 'request') return;
      if (buffer.length < 4) return;
      if (buffer[0] !== 5) {
        socket.destroy();
        return;
      }
      const command = buffer[1];
      const addressType = buffer[3];
      let offset = 4;
      let host;

      if (addressType === 1) {
        if (buffer.length < offset + 4 + 2) return;
        host = [...buffer.subarray(offset, offset + 4)].join('.');
        offset += 4;
      } else if (addressType === 3) {
        if (buffer.length < offset + 1) return;
        const length = buffer[offset];
        if (buffer.length < offset + 1 + length + 2) return;
        host = buffer.subarray(offset + 1, offset + 1 + length).toString('utf8');
        offset += 1 + length;
      } else if (addressType === 4) {
        if (buffer.length < offset + 16 + 2) return;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
        host = `[${parts.join(':')}]`;
        offset += 16;
      } else {
        socket.destroy();
        return;
      }

      const targetPort = buffer.readUInt16BE(offset);
      offset += 2;
      const rest = buffer.subarray(offset);
      buffer = Buffer.alloc(0);

      if (command !== 1) {
        socket.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }

      log({ proto: 'socks', host, port: targetPort, authenticated: false });
      stage = 'tunnel';
      socket.removeListener('data', onData);

      const upstream = net.connect(targetPort, host, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => {
        socket.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
      });
      socket.on('error', () => upstream.destroy());
    };

    socket.on('data', onData);
    socket.on('error', () => {});
  });

  server.listen(port, '127.0.0.1', () => log({ event: 'listen', port }));
}

if (mode === 'socks') startSocksProxy();
else startHttpProxy();
