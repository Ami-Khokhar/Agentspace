'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, RECEIPT_NOTE } = require('../src/server');
const { createAgentSpace } = require('../src/agentspace');

/**
 * The service has no session-creation endpoint (creation stays in the local
 * core), so tests seed a space, wrap it in a service, and speak HTTP to it
 * exactly as a first-party local client would.
 */
async function start(seed) {
  const space = createAgentSpace();
  const service = createServer({ space, port: 0 });
  while (!service.address()) await new Promise((r) => setTimeout(r, 5));
  const port = service.address().port;
  const seeded = seed ? seed(space) : undefined;
  const base = `http://127.0.0.1:${port}`;
  const get = (path, o = {}) => request(base, path, 'GET', null, service.secret, o);
  const post = (path, body) => request(base, path, 'POST', body, service.secret, {});
  return { space, service, base, port, secret: service.secret, get, post, seeded };
}

function request(base, path, method, body, secret, { headers = {}, auth = true, host = null, origin = null, raw = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw === null ? (body === null ? null : Buffer.from(body)) : Buffer.from(raw);
    const req = http.request(base + path, {
      method,
      headers: {
        ...(host ? { host } : {}),
        ...(origin ? { origin } : {}),
        ...(auth && secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...headers,
      },
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('unauthenticated reads and writes are rejected', async () => {
  const { service, base, secret } = await start();
  try {
    const read = await request(base, '/sessions', 'GET', null, null);
    assert.equal(read.status, 401);
    assert.equal(read.headers['www-authenticate'], 'Bearer realm="agentspace-local"');

    const write = await request(base, '/sessions/session-1/events', 'POST', '{"type":"working"}', null);
    assert.equal(write.status, 401);

    const wrong = await request(base, '/sessions', 'GET', null, 'wrong-secret-value-longer');
    assert.equal(wrong.status, 401);
    assert.equal(JSON.parse(wrong.text).error, 'unauthorized');

    // Sanitised: the secret still works, proving rejection is authentication.
    const ok = await request(base, '/sessions', 'GET', null, secret);
    assert.equal(ok.status, 200);
  } finally {
    await service.close();
  }
});

test('service is loopback-only and rejects hostile Origin and Host headers without CORS', async () => {
  const { service, base, port } = await start();
  try {
    assert.equal(service.address().address, '127.0.0.1');

    const rebinding = await request(base, '/sessions', 'GET', null, null, { host: 'attacker.example' });
    assert.equal(rebinding.status, 421);
    assert.equal(JSON.parse(rebinding.text).error, 'badHost');

    const crossOrigin = await request(base, '/sessions', 'GET', null, null, { origin: 'https://evil.example' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.text).error, 'badOrigin');
    assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);

    const wrongPort = await request(base, '/sessions', 'GET', null, null, { origin: `http://127.0.0.1:${port + 1}` });
    assert.equal(wrongPort.status, 403);
  } finally {
    await service.close();
  }
});

test('invalid JSON, oversized bodies and malformed identifiers fail cleanly, without state changes', async () => {
  const startResult = await start((s) => s.createSession().sessionId);
  const sessionId = startResult.seeded;
  const space = startResult.space;
  const { get, post, service } = startResult;
  try {
    const badJson = await post('/sessions/session-1/events', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.text).error, 'badJson');
    assert.ok(!badJson.text.includes('at '), `no stack trace in body: ${badJson.text}`);

    const oversized = await post('/sessions/session-1/events', JSON.stringify({ type: 'working', pad: 'x'.repeat(65 * 1024) }));
    assert.equal(oversized.status, 413);

    const array = await post('/sessions/session-1/events', '[1,2]');
    assert.equal(array.status, 400);

    const malformedPost = await post('/sessions/session-x/questions/question-1/reply', '{"revision":"two","text":"x"}');
    assert.equal(malformedPost.status, 400);

    const malformedGet = await get('/sessions/session-../questions/pending');
    assert.equal(malformedGet.status, 400);

    // Nothing above moved the seeded session's state.
    const after = await get(`/sessions/${sessionId}`);
    assert.equal(JSON.parse(after.text).status, 'working');
  } finally {
    await service.close();
  }
});

test('accepted reply yields 202 with a routing-only receipt that claims no agent delivery', async () => {
  const {
    seeded: { sessionId: alpha, question: asked },
    space,
    service,
    post,
  } = await start((s) => {
    const sessionId = s.createSession().sessionId;
    const question = s.ask(sessionId, 'Ready?');
    return { sessionId, question };
  });
  try {
    const res = await post(`/sessions/${alpha}/questions/${asked.questionId}/reply`, `{"revision":${asked.revision},"text":"yes"}`);
    assert.equal(res.status, 202);
    const receipt = JSON.parse(res.text);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.note, RECEIPT_NOTE);
    assert.ok(/no agent has received/.test(receipt.note), 'receipt states the absence of agent delivery');
    assert.equal(receipt.deliveredToAgent, undefined);
    assert.equal(space.getSessionState(alpha).status, 'working');
  } finally {
    await service.close();
  }
});

test('stale, duplicate and cross-session reply coordinates return distinct error codes', async () => {
  const { seeded: { alpha, beta, staleQ, betaQ, activeQ }, service, post } = await start((space) => {
    const alpha = space.createSession();
    const beta = space.createSession();
    const staleQ = space.ask(alpha.sessionId, 'alpha?');
    const betaQ = space.ask(beta.sessionId, 'beta?');
    const activeQ = space.ask(alpha.sessionId, 'alpha again?'); // stales staleQ
    return { alpha, beta, staleQ, betaQ, activeQ };
  });
  try {
    // Stale: question-1 is superseded by question-3 in session-1.
    const stale = await post(`/sessions/${alpha.sessionId}/questions/${staleQ.questionId}/reply`, `{"revision":${staleQ.revision},"text":"r"}`);
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.text).error, 'questionNotOpen');

    // Duplicate: after a successful reply, the same coordinates again.
    assert.equal((await post(`/sessions/${beta.sessionId}/questions/${betaQ.questionId}/reply`, `{"revision":${betaQ.revision},"text":"r"}`)).status, 202);
    const dup = await post(`/sessions/${beta.sessionId}/questions/${betaQ.questionId}/reply`, `{"revision":${betaQ.revision},"text":"r"}`);
    assert.equal(dup.status, 409);
    assert.equal(JSON.parse(dup.text).error, 'questionNotOpen');

    // Cross-session: beta's question named under alpha's session.
    const cross = await post(`/sessions/${alpha.sessionId}/questions/${betaQ.questionId}/reply`, `{"revision":${betaQ.revision},"text":"r"}`);
    assert.equal(cross.status, 404);
    assert.equal(JSON.parse(cross.text).error, 'unknownQuestion');

    // Revision mismatch on the active question.
    const revision = await post(`/sessions/${alpha.sessionId}/questions/${activeQ.questionId}/reply`, '{"revision":7,"text":"r"}');
    assert.equal(revision.status, 409);
    assert.equal(JSON.parse(revision.text).error, 'revisionMismatch');
  } finally {
    await service.close();
  }
});

test('session and pending-question listings reflect core state', async () => {
  const {
    seeded: { alpha, beta, betaActive },
    service,
    get,
  } = await start((space) => {
    const alpha = space.createSession();
    space.ask(alpha.sessionId, 'one?');
    const beta = space.createSession();
    space.ask(beta.sessionId, 'two?');
    const betaActive = space.ask(beta.sessionId, 'two-b?');
    return { alpha, beta, betaActive };
  });
  try {
    const sessions = JSON.parse((await get('/sessions')).text);
    assert.deepEqual(sessions.sessions.map((s) => [s.status, s.hasPendingQuestion]), [
      ['needs-user', true],
      ['needs-user', true],
    ]);

    const pending = JSON.parse((await get('/questions/pending')).text);
    const pendingList = pending.questions.filter((q) => q.sessionId === alpha.sessionId);
    assert.deepEqual(pending.questions.map((q) => [q.sessionId, q.questionId, q.revision]), [
      [alpha.sessionId, pendingList[0].questionId, 1],
      [beta.sessionId, betaActive.questionId, 2],
    ]);

    const scoped = JSON.parse((await get(`/sessions/${beta.sessionId}/questions/pending`)).text);
    assert.deepEqual(scoped.questions.map((q) => [q.sessionId, q.questionId, q.revision]), [
      [beta.sessionId, betaActive.questionId, 2],
    ]);
  } finally {
    await service.close();
  }
});

test('unknown route and unknown session are 404; session-scoped listing honours the core error', async () => {
  const { get, post, service } = await start();
  try {
    assert.equal((await get('/nope')).status, 404);
    const missing = await get('/sessions/session-99');
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.text).error, 'unknownSession');
    assert.equal((await get('/sessions/session-99/questions/pending')).status, 404);
    assert.equal((await post('/sessions/session-99/events', '{"type":"working"}')).status, 404);
  } finally {
    await service.close();
  }
});
