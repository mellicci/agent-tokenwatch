import http from 'node:http';
import zlib from 'node:zlib';
import { normalizeOtlp } from './normalize/index.mjs';
import { decodeOtlpLogsExportRequest } from './otlp-protobuf.mjs';
import { storeEvents } from './store.mjs';

const MAX_BODY = 8 * 1024 * 1024;
// The body cap above counts compressed bytes, so it does not bound what a gzip
// bomb expands to. A few megabytes of zeros inflate to gigabytes, which stalls
// the event loop and can OOM the process hosting the receiver - and under
// `tokenwatch-codex` that process is also supervising the user's Codex session.
const MAX_DECOMPRESSED = 32 * 1024 * 1024;
// One request must not be able to write an unbounded number of ledger rows and
// per-session state files. Real Codex batches are a handful of records.
const MAX_RECORDS_PER_REQUEST = 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

// Deliberately string-based rather than `new URL(req.url, ...req.headers.host)`.
// Building a URL from the client's own Host header throws on a malformed
// authority, and that throw lands in the 'request' event with no try/catch
// around it, which terminates the whole process. One `Host: [` used to be a
// remote kill switch for the receiver.
function requestPathname(rawUrl) {
  const target = String(rawUrl ?? '');
  // Normal clients send origin-form ("/v1/logs?x=1"); a proxy may send
  // absolute-form ("http://host/v1/logs"), so drop any scheme and authority.
  const withoutOrigin = target.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
  const [pathname] = withoutOrigin.split(/[?#]/);
  return pathname || '/';
}

// A media type, not a substring search. `contentType.includes('json')` also
// matched `text/plain;charset=json`, which is a CORS-simple type: a web page
// could POST forged telemetry into the ledger with no preflight. Requiring an
// exact `application/json` means a browser must preflight, and the preflight
// gets no CORS headers back.
function mediaType(headerValue) {
  return String(headerValue ?? '').split(';')[0].trim().toLowerCase();
}

// Walks the decoded envelope and counts the records it declares, without
// building anything. Stops as soon as the cap is exceeded, so an enormous
// document costs a traversal rather than a normalization.
function countOtlpRecords(payload) {
  let total = 0;
  const groups = [
    ...(Array.isArray(payload?.resourceLogs) ? payload.resourceLogs : []),
    ...(Array.isArray(payload?.resourceMetrics) ? payload.resourceMetrics : [])
  ];
  for (const group of groups) {
    const scopes = [
      ...(Array.isArray(group?.scopeLogs) ? group.scopeLogs : []),
      ...(Array.isArray(group?.scopeMetrics) ? group.scopeMetrics : [])
    ];
    for (const scope of scopes) {
      if (Array.isArray(scope?.logRecords)) total += scope.logRecords.length;
      for (const metric of Array.isArray(scope?.metrics) ? scope.metrics : []) {
        for (const key of ['sum', 'gauge', 'histogram']) {
          const points = metric?.[key]?.dataPoints;
          if (Array.isArray(points)) total += points.length;
        }
      }
      if (total > MAX_RECORDS_PER_REQUEST) return total;
    }
  }
  return total;
}

function gunzip(buffer) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, { maxOutputLength: MAX_DECOMPRESSED }, (error, result) => {
      if (error) reject(Object.assign(error, { statusCode: 413 }));
      else resolve(result);
    });
  });
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        reject(Object.assign(new Error('OTLP request too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function response(res, status, body = '') {
  if (res.headersSent || res.writableEnded) return;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  res.end(text);
}

function protobufResponse(res, status = 200) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/x-protobuf', 'content-length': '0', 'cache-control': 'no-store' });
  res.end();
}

export function createOtlpServer(config, { host, port, quiet = false } = {}) {
  const bindHost = host ?? config.codex.otlpHost ?? '127.0.0.1';
  const bindPort = Number(port ?? config.codex.otlpPort ?? 4318);
  const server = http.createServer(async (req, res) => {
    // Nothing below may throw out of this handler: an uncaught throw here is an
    // uncaughtException, and it would take down whatever process is hosting the
    // receiver rather than failing one request.
    try {
      const pathname = requestPathname(req.url);
      if (req.method === 'GET' && pathname === '/health') {
        response(res, 200, { ok: true, service: 'tokenwatch-otlp' });
        return;
      }
      if (req.method !== 'POST' || !['/v1/logs', '/v1/metrics'].includes(pathname)) {
        response(res, 404, { error: 'not found' });
        return;
      }
      const type = mediaType(req.headers['content-type']);
      const isJson = type === 'application/json';
      const isProtobuf = type === 'application/x-protobuf' || type === 'application/octet-stream';
      if (!isJson && !isProtobuf) {
        response(res, 415, { error: 'Tokenwatch accepts OTLP/HTTP JSON or protobuf logs.' });
        return;
      }
      if (isProtobuf && pathname !== '/v1/logs') {
        response(res, 415, { error: 'Dependency-free protobuf decoding is supported for OTLP logs only.' });
        return;
      }
      let buffer = await readRequest(req);
      if (mediaType(req.headers['content-encoding']) === 'gzip') buffer = await gunzip(buffer);
      const payload = isJson ? JSON.parse(buffer.toString('utf8')) : decodeOtlpLogsExportRequest(buffer);
      // Counted before normalizing, not after. Checking the length of the
      // result meant the cap was paid for first: every record was already
      // built, every identity hashed, every event object retained, and only
      // then was the request refused. The limit has to precede the work it is
      // there to bound.
      if (countOtlpRecords(payload) > MAX_RECORDS_PER_REQUEST) {
        throw Object.assign(new Error(`OTLP request carries more than ${MAX_RECORDS_PER_REQUEST} records`), { statusCode: 413 });
      }
      const events = normalizeOtlp(pathname, payload, config);
      const results = storeEvents(events, config);
      if (isProtobuf) protobufResponse(res, 200);
      else response(res, 200, { partialSuccess: {}, accepted: results.filter((result) => result.stored).length });
    } catch (error) {
      // `error.name` only: a JSON parse error's message quotes a fragment of the
      // body, and the body is the one thing this tool promises never to record.
      if (!quiet) console.error(`tokenwatch OTLP: rejected a request (${error?.name ?? 'Error'})`);
      response(res, error?.statusCode ?? 400, { error: 'invalid OTLP request' });
    }
  });
  // Node's defaults already blunt a classic slow-loris; these make the bound explicit.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  return { server, host: bindHost, port: bindPort };
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').trim().toLowerCase());
}

export async function startOtlpServer(config, options = {}) {
  const instance = createOtlpServer(config, options);
  if (!options.quiet && !isLoopbackHost(instance.host)) {
    console.error(`tokenwatch OTLP: binding to ${instance.host}, which is not loopback. The receiver is unauthenticated; anyone who can reach this address can write telemetry into your ledger.`);
  }
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(instance.port, instance.host, resolve);
  });
  const address = instance.server.address();
  return { ...instance, address, close: () => new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve())) };
}
