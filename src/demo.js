'use strict';

/**
 * Runnable local demo: two clearly labelled simulated sessions against the
 * real local HTTP service. Nothing here connects outward: the service binds
 * to the loopback interface, questions are asked through the core, and both
 * simulated agents reply through the service's own receipts/events routes.
 * Shutdown is deterministic: both scripts finish, both sessions are closed
 * with explicit events, the server is closed, and the demo exits 0.
 */

const crypto = require('node:crypto');
const { createAgentSpace } = require('./agentspace');
const { createServer } = require('./server');
const { SIMULATED_LABEL, createHttpClient, runSimulatedSession, finishSimulatedSession } = require('./simulate');

// Fixed, locally deterministic scripts: questions asked through the core,
// replies given by the session's owning simulated agent only.

const SCRIPT_A = [
  { question: 'What is 2 plus 2?', reply: 'Simulated answer: 4.' },
  { question: 'What is 3 times 3?', reply: 'Simulated answer: 9.' },
];
const SCRIPT_B = [{ question: 'Name the capital of France.', reply: 'Simulated answer: Paris.' }];
const LABEL_A = `${SIMULATED_LABEL} pair-a`;
const LABEL_B = `${SIMULATED_LABEL} pair-b`;

async function runDemo({ port = 0, output = process.stdout } = {}) {
  const space = createAgentSpace();
  const service = createServer({ space, port, secret: crypto.randomBytes(32).toString('base64url') });
  while (!service.address()) await new Promise((r) => setTimeout(r, 5));
  const base = `http://127.0.0.1:${service.address().port}`;
  const client = createHttpClient(base, service.secret);
  const log = (line) => output.write(`${line}\n`);

  log('Agentspace local demo — every line below is SIMULATED; no real agent, no network.');
  const a = space.createSession();
  const b = space.createSession();

  // Both questions are pending at once, so each simulator must find its answer
  // in its own session's scoped pending list only.
  space.ask(a.sessionId, SCRIPT_A[0].question);
  space.ask(b.sessionId, SCRIPT_B[0].question);
  await runSimulatedSession({ client, sessionId: a.sessionId, label: LABEL_A, turns: [SCRIPT_A[0].reply], onLine: log });
  await runSimulatedSession({ client, sessionId: b.sessionId, label: LABEL_B, turns: [SCRIPT_B[0].reply], onLine: log });
  space.ask(a.sessionId, SCRIPT_A[1].question);
  await runSimulatedSession({ client, sessionId: a.sessionId, label: LABEL_A, turns: [SCRIPT_A[1].reply], onLine: log });

  await finishSimulatedSession(client, a.sessionId);
  await finishSimulatedSession(client, b.sessionId);
  for (const session of space.listSessions()) {
    log(`${session.sessionId}: ${session.status} ${SIMULATED_LABEL} (receipts were acceptance-only; nothing was delivered or acknowledged)`);
  }
  await service.close();
  log('Demo finished deterministically');
  return { service, space };
}

if (require.main === module) {
  runDemo().catch((err) => {
    process.stderr.write(`agentspace demo: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runDemo };
