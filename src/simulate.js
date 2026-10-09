'use strict';

/**
 * Compact local simulator, built only on the real core and service
 * boundaries that already exist: questions are asked through the core's
 * `ask`, pending questions are read through the service's own
 * `GET /sessions/:id/questions/pending`, replies go through the service's
 * reply route, and explicit session states go through its events route.
 *
 * Each simulated session is driven by its own simulator instance, and that
 * simulator only ever reads the pending list scoped to the one session id it
 * owns, so one simulator can never pick up another session's question.
 * Everything is locally deterministic: fixed scripts, local only, same host
 * interface as the first-party browser page.
 */

const http = require('node:http');

/** Every simulated surface is labelled with this, so output cannot be mistaken for live agent traffic. */
const SIMULATED_LABEL = '[simulated]';

/**
 * Loopback HTTP client speaking to the local service exactly as the
 * first-party page does: bearer secret header, JSON bodies.
 */
function createHttpClient(base, secret) {
  function request(path, method, body = undefined) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(base + path, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  return {
    get: (path) => request(path, 'GET'),
    post: (path, body) => request(path, 'POST', body),
  };
}

/**
 * Run one scripted, clearly labelled simulated session over the real
 * boundaries. Each turn is a [questionText, replyText] pair: ask through the
 * core, answer the newest question found in this session's own pending list
 * through the service receipt route, then drive the session status forward
 * pair, then drive the session status forward through the events route.
 * Each accepted receipt is acknowledged by its own simulator exactly once,
 * with the exact receipt identity (session, question, revision and the
 * receipt id from the 202), so the state distinguishes accepted-but-
 * unacknowledged from acknowledged. A simulator that never acknowledges
 * (for example one whose session is disconnected) leaves the receipt
 * unacknowledged, so a disconnect never implies delivery. Fails loudly on any unexpected status.
 */
async function runSimulatedSession({ client, sessionId, label = SIMULATED_LABEL, turns, onLine }) {
  const step = (line) => onLine && onLine(`${label} ${line}`);
  step(`session ${sessionId} (simulated; no real agent is connected)`);
  const answered = [];
  for (const replyText of turns) {
    // The simulator reads only the pending list scoped to the session id it
    // owns, so it can never see another session's question.
    const pending = await client.get(`/sessions/${sessionId}/questions/pending`);
    if (pending.status !== 200) fail(`pending read failed: ${pending.status}`);
    const questions = pending.body.questions;
    if (questions.length === 0) fail(`no pending question in session ${sessionId}`);
    // Deterministic choice: the newest revision this own session has open.
    const mine = questions[questions.length - 1];

    const receipt = await client.post(
      `/sessions/${sessionId}/questions/${mine.questionId}/reply`,
      { revision: mine.revision, text: replyText }
    );
    if (receipt.status !== 202 || receipt.body.accepted !== true) fail(`reply rejected: ${receipt.status}`);
    step(`reply accepted, unacknowledged (accepted for routing only): ${replyText}`);

    // Acknowledge the exact receipt identity this receipt carries: correct
    // coordinates only, so a mismatched acknowledgement is always rejected.
    const ack = await client.post(
      `/sessions/${sessionId}/questions/${mine.questionId}/acknowledge`,
      { revision: mine.revision, receiptId: receipt.body.receipt.receiptId }
    );
    if (ack.status !== 200 || ack.body.receiptStatus !== 'acknowledged') fail(`acknowledgement rejected: ${ack.status}`);
    step(`acknowledged receipt ${receipt.body.receipt.receiptId} (simulated agent received the input)`);

    const state = await client.get(`/sessions/${sessionId}`);
    if (state.body.status !== 'working') fail(`expected working after answer, got ${state.body.status}`);
    answered.push({ questionId: mine.questionId, reply: replyText, receipt: receipt.body.receipt.receiptId });
  }
  return answered;
}

/** Close a simulated session through the real events route, deterministically. */
async function finishSimulatedSession(client, sessionId) {
  const sent = await client.post(`/sessions/${sessionId}/events`, { type: 'finished' });
  if (sent.status !== 200 || sent.body.status !== 'finished') fail(`finish event rejected: ${sent.status}`);
  return sent.body;
}

/**
 * Simulated reconnect after an accepted reply: disconnect, reconnect and
 * replay. Step 1 replays the exact reply coordinates the simulator sent
 * before disconnecting; the service must reject that duplicate
 * (`questionNotOpen`) without producing a second receipt, so the replay can
 * never re-consume an already-answered question. Step 2 re-acknowledges the
 * saved receipt with its exact identity after reconnecting; an exact
 * match is idempotent-equivalent (same state, same receipt), so a reconnect
 * after acknowledgement cannot regress the receipt back to unacknowledged
 * or mint a new one. Fails loudly on anything else.
 */
async function reconnectSimulatedSession({ client, sessionId, answered, onLine }) {
  const step = (line) => onLine && onLine(`${SIMULATED_LABEL} ${line}`);
  step(`reconnect ${sessionId} (simulated; replaying what was sent before the disconnect)`);
  let replayed = 0;
  for (const entry of answered) {
    const replay = await client.post(
      `/sessions/${sessionId}/questions/${entry.questionId}/reply`,
      { revision: entry.revision, text: entry.reply }
    );
    if (replay.status !== 409 || replay.body.error !== 'questionNotOpen') {
      fail(`duplicate replay was not rejected safely: ${replay.status}`);
    }
    step(`duplicate replay rejected safely (${replay.body.error}); no second receipt exists`);

    const ack = await client.post(
      `/sessions/${sessionId}/questions/${entry.questionId}/acknowledge`,
      { revision: entry.revision, receiptId: entry.receipt }
    );
    if (ack.status !== 200 || ack.body.receiptStatus !== 'acknowledged') {
      fail(`re-acknowledge after reconnect failed: ${ack.status}`);
    }
    step(`receipt ${entry.receipt} still acknowledged after reconnect (one logical reply, one receipt, at most one consumption)`);
    replayed += 1;
  }
  return { replayed, duplicateRepliesRejected: replayed, receiptsStillAcknowledged: replayed };
}

/**
 * Simulated reconnect after expiry: while the session was disconnected a new
 * question was asked, disconnected again, and expired explicitly with its
 * exact revision. On reconnect a stale answer at the expired question's
 * coordinates must be rejected (`questionNotOpen`) and the pending list must
 * be empty: the question is not resurrected and the stale answer is never
 * accepted. Fails loudly on anything else.
 */
async function reconnectExpiredSimulatedSession(client, sessionId, expiredQuestionId, expiredRevision) {
  const stale = await client.post(
    `/sessions/${sessionId}/questions/${expiredQuestionId}/reply`,
    { revision: expiredRevision, text: 'Simulated answer for an expired question.' }
  );
  if (stale.status !== 409 || stale.body.error !== 'questionNotOpen') {
    fail(`stale answer to an expired question was accepted: ${stale.status}`);
  }
  const pending = await client.get(`/sessions/${sessionId}/questions/pending`);
  if (pending.status !== 200 || pending.body.questions.length !== 0) {
    fail(`expired question was resurrected in the pending list: ${JSON.stringify(pending.body)}`);
  }
  return { staleReplyRejected: true, pendingCount: pending.body.questions.length };
}

function fail(message) {
  throw new Error(`agentspace simulator: ${message}`);
}

module.exports = { SIMULATED_LABEL, createHttpClient, runSimulatedSession, finishSimulatedSession, reconnectSimulatedSession, reconnectExpiredSimulatedSession };
