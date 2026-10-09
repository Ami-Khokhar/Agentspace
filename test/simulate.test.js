'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentSpace } = require('../src/agentspace');
const { createServer, RECEIPT_NOTE } = require('../src/server');
const { SIMULATED_LABEL, createHttpClient, runSimulatedSession, finishSimulatedSession } = require('../src/simulate');
const { runDemo } = require('../src/demo');

/** Start the real local HTTP service with a fresh core and speak to it exactly as a local client. */
async function startService() {
  const space = createAgentSpace();
  const service = createServer({ space, port: 0 });
  while (!service.address()) await new Promise((r) => setTimeout(r, 5));
  const client = createHttpClient(`http://127.0.0.1:${service.address().port}`, service.secret);
  return { space, service, client };
}

test('two simulated sessions over the real service: only the owning simulator answers its question', async () => {
  const { space, service, client } = await startService();
  try {
    const a = space.createSession();
    const b = space.createSession();
    // Ask in both sessions first, so each pending list is populated before either simulator runs.
    const qA = space.ask(a.sessionId, 'What is 2 plus 2?');
    const qB = space.ask(b.sessionId, 'Name the capital of France.');

    // Simulator A only reads its own session's pending list, so even with
    // B's question pending it can only ever see and answer A's question.
    const seenByA = await client.get(`/sessions/${a.sessionId}/questions/pending`);
    assert.deepEqual(seenByA.body.questions.map((q) => q.questionId), [qA.questionId]);
    const seenByB = await client.get(`/sessions/${b.sessionId}/questions/pending`);
    assert.deepEqual(seenByB.body.questions.map((q) => q.questionId), [qB.questionId]);
    // Reply coordinates from one session are rejected on the other's path:
    // only the owning simulator can consume its own pending question.
    const crossPost = await client.post(
      `/sessions/${a.sessionId}/questions/${qB.questionId}/reply`,
      { revision: qB.revision, text: 'wrong session' }
    );
    assert.equal(crossPost.status, 404);
    assert.equal(crossPost.body.error, 'unknownQuestion');
    assert.equal(space.getSessionState(b.sessionId).activeQuestion.questionId, qB.questionId);

    const linesA = [];
    const answeredA = await runSimulatedSession({
      client, sessionId: a.sessionId,
      turns: ['Simulated answer: 4.'],
      onLine: (l) => linesA.push(l),
    });
    assert.equal(answeredA.length, 1);
    assert.equal(answeredA[0].questionId, qA.questionId);
    assert.ok(linesA.every((l) => l.startsWith(SIMULATED_LABEL)));

    // After A's simulator ran: A's question is answered through the service,
    // B's question is still open — B's simulator did not consume A's reply
    // and A's simulator did not consume B's.
    const stateA = await client.get(`/sessions/${a.sessionId}`);
    const stateB = await client.get(`/sessions/${b.sessionId}`);
    assert.equal(stateA.body.status, 'working');
    assert.equal(stateA.body.activeQuestion, null);
    assert.equal(stateB.body.status, 'needs-user');
    assert.equal(stateB.body.activeQuestion.questionId, qB.questionId);
    assert.equal(stateB.body.activeQuestion.status, 'open');

    const answeredB = await runSimulatedSession({
      client, sessionId: b.sessionId,
      turns: ['Simulated answer: Paris.'],
      onLine: () => {},
    });
    assert.equal(answeredB.length, 1);
    assert.equal(answeredB[0].questionId, qB.questionId);
    const finalB = await client.get(`/sessions/${b.sessionId}`);
    assert.equal(finalB.body.status, 'working');
    assert.equal(finalB.body.activeQuestion, null);
  } finally {
    await service.close();
  }
});

test('acceptance alone never produces delivered or acknowledged state', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'Hello?');
    const receipt = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/reply`,
      { revision: q.revision, text: 'Simulated answer.' }
    );
    assert.equal(receipt.status, 202);
    assert.equal(receipt.body.accepted, true);
    // The receipt names acceptance-for-routing only.
    assert.equal(receipt.body.note, RECEIPT_NOTE);
    assert.equal(receipt.body.delivered, undefined);
    assert.equal(receipt.body.acknowledged, undefined);

    // No session state named delivered or acknowledged exists, and the
    // explicit events route never accepts any such state.
    const states = [await client.get(`/sessions/${s.sessionId}`), await client.get('/sessions')];
    for (const read of states) {
      assert.equal(JSON.stringify(read.body).includes('delivered'), false);
      assert.equal(JSON.stringify(read.body).includes('acknowledged'), false);
    }
    const bogus = await client.post(`/sessions/${s.sessionId}/events`, { type: 'acknowledged' });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error, 'badEvent');
    const state = space.getSessionState(s.sessionId);
    assert.equal(state.status, 'working');
    assert.equal(state.activeQuestion, null);
    await finishSimulatedSession(client, s.sessionId);
    assert.equal((await client.get(`/sessions/${s.sessionId}`)).body.status, 'finished');
  } finally {
    await service.close();
  }
});

test('demo populates two labelled simulated sessions with deterministic shutdown', async () => {
  const written = [];
  const output = { write: (line) => written.push(line.replace(/\n$/, '')) };
  const { space, service } = await runDemo({ output });
  // Deterministic shutdown: the service closed.
  assert.equal(service.address(), null);
  const simulated = written.filter((l) => l.startsWith(SIMULATED_LABEL));
  assert.ok(simulated.length >= 2);
  const summary = written.filter((l) => /: finished \[simulated\]/.test(l));
  assert.equal(summary.length, 2);
  assert.deepEqual(space.listSessions().map((s) => s.status), ['finished', 'finished']);
  assert.ok(written.some((l) => l.includes('not delivered, not acknowledged')));
  assert.ok(written[written.length - 1] === 'Demo finished deterministically');
});
