'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentSpace } = require('../src/agentspace');
const { createServer, RECEIPT_NOTE } = require('../src/server');
const { SIMULATED_LABEL, createHttpClient, runSimulatedSession, finishSimulatedSession, reconnectSimulatedSession, reconnectExpiredSimulatedSession } = require('../src/simulate');
const { runDemo } = require('../src/demo');
const { EXPIRED_NOTE } = require('../src/server');

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
    // The new receipt is explicitly unacknowledged: accepted, never claimed delivered.
    assert.equal(receipt.body.receipt.status, 'unacknowledged');
    assert.match(receipt.body.receipt.receiptId, /^receipt-[1-9][0-9]*$/);

    // Session state names the receipt with its honest unacknowledged status,
    // and no reply state anywhere claims delivery or acknowledgement.
    const states = [await client.get(`/sessions/${s.sessionId}`), await client.get('/sessions')];
    for (const read of states) {
      assert.equal(JSON.stringify(read.body).includes('delivered'), false);
    }
    const state = space.getSessionState(s.sessionId);
    assert.deepEqual(state.receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId: receipt.body.receipt.receiptId, status: 'unacknowledged' },
    ]);
    const bogus = await client.post(`/sessions/${s.sessionId}/events`, { type: 'acknowledged' });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error, 'badEvent');
    assert.equal(state.status, 'working');
    assert.equal(state.activeQuestion, null);
    await finishSimulatedSession(client, s.sessionId);
    assert.equal((await client.get(`/sessions/${s.sessionId}`)).body.status, 'finished');
    // Even after finishing, the unacknowledged receipt stays unacknowledged:
    // no event state implies delivery or acknowledgement.
    assert.equal(space.getSessionState(s.sessionId).receipts[0].status, 'unacknowledged');
  } finally {
    await service.close();
  }
});

test('only the owning simulator matching acknowledgement changes the receipt state', async () => {
  const { space, service, client } = await startService();
  try {
    // Two sessions with one accepted reply each, so unrelated state must stay intact.
    const a = space.createSession();
    const b = space.createSession();
    const qa = space.ask(a.sessionId, 'A?');
    const qb = space.ask(b.sessionId, 'B?');
    const ra = await client.post(`/sessions/${a.sessionId}/questions/${qa.questionId}/reply`, { revision: qa.revision, text: 'A.' });
    const rb = await client.post(`/sessions/${b.sessionId}/questions/${qb.questionId}/reply`, { revision: qb.revision, text: 'B.' });
    assert.equal(ra.status, 202); assert.equal(rb.status, 202);
    const receiptA = ra.body.receipt.receiptId;
    const receiptB = rb.body.receipt.receiptId;
    const ackPathA = `/sessions/${a.sessionId}/questions/${qa.questionId}/acknowledge`;

    // Every mismatched acknowledgement is rejected: wrong receipt id, wrong
    // session, wrong question, wrong revision.
    const wrongReceipt = await client.post(ackPathA, { revision: qa.revision, receiptId: receiptB });
    assert.equal(wrongReceipt.status, 409);
    assert.equal(wrongReceipt.body.error, 'receiptMismatch');
    const wrongSession = await client.post(`/sessions/${b.sessionId}/questions/${qa.questionId}/acknowledge`, { revision: qa.revision, receiptId: receiptA });
    assert.equal(wrongSession.status, 404);
    assert.equal(wrongSession.body.error, 'unknownQuestion');
    const wrongQuestion = await client.post(`/sessions/${a.sessionId}/questions/${qb.questionId}/acknowledge`, { revision: qa.revision, receiptId: receiptA });
    assert.equal(wrongQuestion.status, 404);
    const wrongRevision = await client.post(ackPathA, { revision: qa.revision + 999, receiptId: receiptA });
    assert.equal(wrongRevision.status, 409);
    assert.equal(wrongRevision.body.error, 'revisionMismatch');
    const malformed = await client.post(ackPathA, { revision: qa.revision, receiptId: 'receipt-nope' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'badAcknowledge');

    // None of the failures above changed either receipt's state.
    assert.deepEqual(space.getSessionState(a.sessionId).receipts, [
      { questionId: qa.questionId, revision: qa.revision, receiptId: receiptA, status: 'unacknowledged' },
    ]);
    assert.deepEqual(space.getSessionState(b.sessionId).receipts, [
      { questionId: qb.questionId, revision: qb.revision, receiptId: receiptB, status: 'unacknowledged' },
    ]);

    // The exact matching acknowledgement (owning session, own question, own
    // revision, own receipt id) is the only thing that changes the state.
    const matched = await client.post(ackPathA, { revision: qa.revision, receiptId: receiptA });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.receiptStatus, 'acknowledged');
    assert.deepEqual(space.getSessionState(a.sessionId).receipts, [
      { questionId: qa.questionId, revision: qa.revision, receiptId: receiptA, status: 'acknowledged' },
    ]);
    assert.deepEqual(space.getSessionState(b.sessionId).receipts, [
      { questionId: qb.questionId, revision: qb.revision, receiptId: receiptB, status: 'unacknowledged' },
    ]);
  } finally {
    await service.close();
  }
});

test('a disconnected session accepted reply stays unacknowledged: disconnection never implies delivery', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'Still there?');
    const receipt = await client.post(`/sessions/${s.sessionId}/questions/${q.questionId}/reply`, { revision: q.revision, text: 'Simulated answer.' });
    assert.equal(receipt.status, 202);
    // The simulator disconnects (explicit event) without acknowledging; nothing reports delivered.
    const disconnected = await client.post(`/sessions/${s.sessionId}/events`, { type: 'disconnected' });
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.status, 'disconnected');
    const read = await client.get(`/sessions/${s.sessionId}`);
    assert.equal(JSON.stringify(read.body).includes('delivered'), false);
    assert.deepEqual(space.getSessionState(s.sessionId).receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId: receipt.body.receipt.receiptId, status: 'unacknowledged' },
    ]);
    // Disconnection also closes the acknowledgement path: a later
    // acknowledgement cannot rewrite history after the fact.
    const lateAck = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/acknowledge`,
      { revision: q.revision, receiptId: receipt.body.receipt.receiptId }
    );
    assert.equal(lateAck.status, 409);
    assert.equal(lateAck.body.error, 'sessionClosed');
    assert.equal(space.getSessionState(s.sessionId).receipts[0].status, 'unacknowledged');
  } finally {
    await service.close();
  }
});

test('replayed replies, acknowledgements and events after a reconnect are each consumed at most once', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'One answer only.');
    const ackPath = `/sessions/${s.sessionId}/questions/${q.questionId}/acknowledge`;
    const posted = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/reply`,
      { revision: q.revision, text: 'Simulated answer.' }
    );
    assert.equal(posted.status, 202);
    const receiptId = posted.body.receipt.receiptId;

    // The connection drops and the same reply is replayed after reconnect:
    // the service must reject the duplicate without minting a second receipt.
    const replayed = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/reply`,
      { revision: q.revision, text: 'Simulated answer.' }
    );
    assert.equal(replayed.status, 409);
    assert.equal(replayed.body.error, 'questionNotOpen');
    assert.deepEqual(space.getSessionState(s.sessionId).receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId, status: 'unacknowledged' },
    ]);

    // The replayed acknowledgement holds the exact receipt identity, so the
    // reconnect lands on the same single receipt; replaying it again cannot
    // mint another receipt or regress the state back to unacknowledged.
    const ack = await client.post(ackPath, { revision: q.revision, receiptId });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.receiptStatus, 'acknowledged');
    const ackAgain = await client.post(ackPath, { revision: q.revision, receiptId });
    assert.equal(ackAgain.status, 200);
    assert.equal(ackAgain.body.receiptStatus, 'acknowledged');
    assert.deepEqual(space.getSessionState(s.sessionId).receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId, status: 'acknowledged' },
    ]);

    // A replayed terminal event is likewise consumed at most once: the second
    // one is rejected and no state is corrupted.
    const finished = await client.post(`/sessions/${s.sessionId}/events`, { type: 'finished' });
    assert.equal(finished.status, 200);
    assert.equal(finished.body.status, 'finished');
    const reFinished = await client.post(`/sessions/${s.sessionId}/events`, { type: 'finished' });
    assert.equal(reFinished.status, 409);
    assert.equal(reFinished.body.error, 'sessionClosed');
    assert.deepEqual(space.getSessionState(s.sessionId).receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId, status: 'acknowledged' },
    ]);
  } finally {
    await service.close();
  }
});

test('reconnect after acknowledgement: no repeated consumption and no receipt regression', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'Still know this?');
    const answered = [{ questionId: q.questionId, revision: q.revision, reply: 'Simulated answer: yes.', receipt: null }];
    const posted = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/reply`,
      { revision: q.revision, text: answered[0].reply }
    );
    assert.equal(posted.status, 202);
    answered[0].receipt = posted.body.receipt.receiptId;

    const lines = [];
    const reconnect = await reconnectSimulatedSession({ client, sessionId: s.sessionId, answered, onLine: (l) => lines.push(l) });
    assert.ok(reconnect);
    assert.ok(lines.every((l) => l.startsWith(SIMULATED_LABEL)));
    assert.ok(lines.some((l) => l.includes('duplicate replay rejected safely (questionNotOpen)')));
    assert.ok(lines.some((l) => l.includes('still acknowledged after reconnect')));
    // The state proves the same three claims the helper asserted: the answer
    // was consumed exactly once, the receipt did not regress, no new receipt.
    assert.deepEqual(space.getSessionState(s.sessionId).receipts, [
      { questionId: q.questionId, revision: q.revision, receiptId: answered[0].receipt, status: 'acknowledged' },
    ]);
    assert.equal(space.getSessionState(s.sessionId).status, 'working');
    assert.equal(space.getSessionState(s.sessionId).activeQuestion, null);
  } finally {
    await service.close();
  }
});

test('a question expired during disconnection stays expired: no resurrection, no stale answer', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'Will this survive?');
    const pendingBefore = await client.get(`/sessions/${s.sessionId}/questions/pending`);
    assert.equal(pendingBefore.body.questions.length, 1);

    // The connection drops while the question is pending; while it is
    // disconnected the question is expired explicitly with its exact revision.
    const wrongRevision = await client.post(`/sessions/${s.sessionId}/questions/${q.questionId}/expire`, { revision: q.revision + 3 });
    assert.equal(wrongRevision.status, 409);
    assert.equal(wrongRevision.body.error, 'revisionMismatch');
    const missing = await client.post(`/sessions/${s.sessionId}/questions/question-999/expire`, { revision: 1 });
    assert.equal(missing.status, 404);
    const malformed = await client.post(`/sessions/${s.sessionId}/questions/${q.questionId}/expire`, {});
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'badExpire');
    const expired = await client.post(`/sessions/${s.sessionId}/questions/${q.questionId}/expire`, { revision: q.revision });
    assert.equal(expired.status, 200);
    assert.equal(expired.body.questionId, q.questionId);
    assert.equal(expired.body.status, 'expired');
    assert.equal(expired.body.note, EXPIRED_NOTE);

    // Reconnect: the expired question is not resurrected in the pending list
    // and a replayed answer at its former coordinates is rejected.
    const reconnect = await reconnectExpiredSimulatedSession(client, s.sessionId, q.questionId, q.revision);
    assert.deepEqual(reconnect, { staleReplyRejected: true, pendingCount: 0 });
    const state = space.getSessionState(s.sessionId);
    assert.equal(state.status, 'working');
    assert.equal(state.activeQuestion, null);

    // Even a refreshed replacement cannot absorb the stale coordinates: a new
    // question gets a newer revision, and the stale answer is still rejected.
    const q2 = space.ask(s.sessionId, 'Fresh question.');
    assert.equal(q2.revision, q.revision + 1);
    const staleAtNew = await client.post(
      `/sessions/${s.sessionId}/questions/${q2.questionId}/reply`,
      { revision: q.revision, text: 'Simulated answer to the expired question.' }
    );
    assert.equal(staleAtNew.status, 409);
    assert.equal(staleAtNew.body.error, 'revisionMismatch');
    // The reconnect ends with the simulator answering only the fresh question.
    const answered = await runSimulatedSession({
      client, sessionId: s.sessionId, turns: ['Simulated answer: fresh.'], onLine: () => {},
    });
    assert.deepEqual(answered.map((a) => a.questionId), [q2.questionId]);
  } finally {
    await service.close();
  }
});

test('expiry on a terminal session is rejected over HTTP: no resurrected session, no later asks', async () => {
  const { space, service, client } = await startService();
  try {
    const s = space.createSession();
    const q = space.ask(s.sessionId, 'Still pending?');
    const finished = await client.post(`/sessions/${s.sessionId}/events`, { type: 'finished' });
    assert.equal(finished.status, 200);
    const expired = await client.post(`/sessions/${s.sessionId}/questions/${q.questionId}/expire`, { revision: q.revision });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error, 'sessionClosed');
    // The terminal session was not resurrected: a later reply at the still-open
    // question's coordinates is rejected like any other action on a closed session.
    const lateReply = await client.post(
      `/sessions/${s.sessionId}/questions/${q.questionId}/reply`,
      { revision: q.revision, text: 'Too late?' }
    );
    assert.equal(lateReply.status, 409);
    assert.equal(lateReply.body.error, 'sessionClosed');
    assert.equal(space.getSessionState(s.sessionId).status, 'finished');
    assert.equal(space.getSessionState(s.sessionId).activeQuestion.status, 'open');
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
  assert.ok(written.some((l) => l.includes('accepted, unacknowledged')));
  assert.ok(written.some((l) => l.includes('acknowledged receipt receipt-')));
  assert.ok(written.some((l) => l.includes('acknowledged by the simulated agents')));
  assert.ok(written[written.length - 1] === 'Demo finished deterministically');
});
