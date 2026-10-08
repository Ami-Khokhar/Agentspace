'use strict';

/**
 * Small authenticated HTTP facade over the Agentspace core.
 *
 * Binds to the loopback interface only (no host option is offered), requires
 * a per-launch bearer secret on every request, and rejects cross-origin or
 * non-loopback Host requests from browsers. No CORS headers are ever sent,
 * no subprocess is spawned, no file system or network access is exposed, and
 * the secret never appears in a URL or a log line.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { createAgentSpace, AgentSpaceError } = require('./agentspace');

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_ERROR_STATUS = {
  badEvent: 400,
  unknownSession: 404,
  sessionClosed: 409,
  unknownQuestion: 404,
  questionNotOpen: 409,
  revisionMismatch: 409,
  sessionHasOpenQuestion: 409,
};

/** Receipts state acceptance-for-routing only; no agent adapter exists yet. */
const RECEIPT_NOTE = 'accepted for routing by the local service; no agent has received or acknowledged this input';

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Accept only looppack Host values; anything else is a DNS-rebinding attempt. */
function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  const bare = hostHeader.toLowerCase();
  return bare === `127.0.0.1:${port}` || bare === `localhost:${port}` || bare === `[::1]:${port}`;
}

/**
 * Browsers attach Origin on cross-origin and some same-origin requests.
 * A first-party local page may use the loopback origin; anything else is
 * untrusted and rejected before the body is read.
 */
function originAllowed(originHeader, port) {
  if (originHeader === undefined) return true; // non-browser client
  return originHeader === `http://127.0.0.1:${port}` || originHeader === `http://localhost:${port}`;
}

function parseJsonBody(raw) {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

const SESSION_ID = /^session-[1-9][0-9]*$/;
const QUESTION_ID = /^question-[1-9][0-9]*$/;


function createServer({ space = createAgentSpace(), port = 0, secret = crypto.randomBytes(32).toString('base64url') } = {}) {
  const server = http.createServer(handle);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function send(res, status, body) {
    const json = JSON.stringify(body);
    // Deliberately no Access-Control-Allow-* headers: no cross-origin use.
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
    });
    res.end(json);
  }


  /** Malformed path identifiers are 400 before any core lookup can change state. */
  function rejectBadIds(res, ids) {
    for (const [value, pattern] of ids) {
      if (!pattern.test(value)) {
        send(res, 400, { error: 'badIdentifier', message: 'path identifier is not a valid id' });
        return true;
      }
    }
    return false;
  }

  function errorStatus(err) {
    return ALLOWED_ERROR_STATUS[err.name] || 500;
  }

  /** Map a core rejection to a status; unknown names get a plain 500. */
  function sendError(res, err) {
    if (err instanceof AgentSpaceError) {
      send(res, errorStatus(err), { error: err.name, message: err.message });
    } else {
      send(res, 500, { error: 'internal', message: 'unexpected failure' });
    }
  }

  function bearer(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(secret);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function readBody(req, res, next) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        chunks.length = 0; // discard
        send(res, 413, { error: 'bodyTooLarge', message: `body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const parsed = parseJsonBody(Buffer.concat(chunks).toString('utf8'));
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        send(res, 400, { error: 'badJson', message: 'request body must be a JSON object' });
        return;
      }
      next(parsed.value);
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        res.destroy();
      }
    });
  }

  /** Routes are listed explicitly; there is no dynamic or shell-dispatched path. */
  const routes = [
    { method: 'GET', pattern: /^\/sessions$/, handler: (req, res) => send(res, 200, { sessions: space.listSessions() }) },
    {
      method: 'GET',
      pattern: /^\/questions\/pending$/,
      handler: (req, res) => send(res, 200, { questions: space.listPendingQuestions() }),
    },
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)$/,
      handler: (req, res, m) => {
        if (rejectBadIds(res, [[m[1], SESSION_ID]])) return;
        try {
          send(res, 200, space.getSessionState(m[1]));
        } catch (err) {
          sendError(res, err);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)\/questions\/pending$/,
      handler: (req, res, m) => {
        if (rejectBadIds(res, [[m[1], SESSION_ID]])) return;
        try {
          send(res, 200, { questions: space.listPendingQuestions(m[1]) });
        } catch (err) {
          sendError(res, err);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/sessions\/([^/]+)\/questions\/([^/]+)\/reply$/,
      handler: (req, res, m, body) => {
        if (rejectBadIds(res, [[m[1], SESSION_ID], [m[2], QUESTION_ID]])) return;
        const revision = body.revision;
        if (!Number.isInteger(revision) || typeof body.text !== 'string' || body.text.length === 0) {
          send(res, 400, { error: 'badReply', message: 'reply needs an integer revision and non-empty text' });
          return;
        }
        try {
          space.reply({ sessionId: m[1], questionId: m[2], revision, text: body.text });
          send(res, 202, { accepted: true, note: RECEIPT_NOTE });
        } catch (err) {
          sendError(res, err);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/sessions\/([^/]+)\/events$/,
      handler: (req, res, m, body) => {
        try {
          send(res, 200, space.sendEvent(m[1], body));
        } catch (err) {
          sendError(res, err);
        }
      },
    },
  ];

  function handle(req, res) {
    // Loopback-only: reject any non-loopback peer before anything else.
    if (!isLoopbackIp(req.socket.remoteAddress)) {
      send(res, 403, { error: 'forbidden', message: 'service accepts loopback connections only' });
      return;
    }
    if (!hostAllowed(req.headers.host, server.address().port)) {
      send(res, 421, { error: 'badHost', message: 'Host header is not the loopback service address' });
      return;
    }
    if (!originAllowed(req.headers.origin, server.address().port)) {
      send(res, 403, { error: 'badOrigin', message: 'Origin is not the local service origin' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      send(res, 405, { error: 'badMethod', message: 'only GET and POST are supported' });
      return;
    }
    if (!bearer(req)) {
      res.setHeader('www-authenticate', 'Bearer realm="agentspace-local"');
      send(res, 401, { error: 'unauthorized', message: 'missing or invalid bearer token' });
      return;
    }
    const path = new URL(req.url, `http://127.0.0.1`).pathname;
    const route = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!route) {
      send(res, 404, { error: 'notFound', message: 'no such route' });
      return;
    }
    const match = route.pattern.exec(path);
    if (req.method === 'GET') {
      route.handler(req, res, match);
    } else {
      readBody(req, res, (body) => route.handler(req, res, match, body));
    }
  }

  server.listen(port, '127.0.0.1');

  return {
    secret, // for the local first-party client's bootstrap only; never logged
    close: () => new Promise((resolve) => server.close(resolve)),
    address: () => server.address(),
  };
}

module.exports = { createServer, RECEIPT_NOTE };
