'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentSpace, AgentSpaceError, ERRORS, TERMINAL_STATES } = require('../src/agentspace');

function errorCode(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof AgentSpaceError, `expected AgentSpaceError, got ${err}`);
    return err.name;
  }
}

test('reply for one session is never applied to another session', () => {
  const space = createAgentSpace();
  const alpha = space.createSession();
  const beta = space.createSession();
  assert.notEqual(alpha.sessionId, beta.sessionId);
  const alphaQuestion = space.ask(alpha.sessionId, 'alpha question?');
  const betaQuestion = space.ask(beta.sessionId, 'beta question?');

  // A reply naming beta's question under alpha's session id is rejected,
  // and alpha's question stays open.
  assert.equal(
    errorCode(() => space.reply({ sessionId: alpha.sessionId, questionId: betaQuestion.questionId, revision: betaQuestion.revision, text: 'r' })),
    ERRORS.unknownQuestion
  );
  assert.equal(space.getSessionState(alpha.sessionId).activeQuestion.questionId, alphaQuestion.questionId);
  assert.equal(space.getSessionState(alpha.sessionId).status, 'needs-user');
  assert.equal(space.getSessionState(beta.sessionId).status, 'needs-user');

  // The correctly routed reply only affects its own session.
  const answered = space.reply({ sessionId: beta.sessionId, questionId: betaQuestion.questionId, revision: betaQuestion.revision, text: 'for beta' });
  assert.equal(answered.status, 'answered');
  assert.equal(space.getSessionState(beta.sessionId).activeQuestion, null);
  assert.equal(space.getSessionState(beta.sessionId).status, 'working');
  assert.equal(space.getSessionState(alpha.sessionId).status, 'needs-user');
  assert.equal(space.getSessionState(alpha.sessionId).activeQuestion.questionId, alphaQuestion.questionId);
});

test('reply to unknown question or unknown session is rejected', () => {
  const space = createAgentSpace();
  const alpha = space.createSession();
  space.ask(alpha.sessionId, 'q1?');
  assert.equal(
    errorCode(() => space.reply({ sessionId: alpha.sessionId, questionId: 'question-999', revision: 1, text: 'r' })),
    ERRORS.unknownQuestion
  );
  assert.equal(
    errorCode(() => space.reply({ sessionId: 'session-999', questionId: 'question-1', revision: 1, text: 'r' })),
    ERRORS.unknownSession
  );
});

test('superseded question revision is stale and its reply is rejected', () => {
  const space = createAgentSpace();
  const session = space.createSession();
  const first = space.ask(session.sessionId, 'first?');
  const second = space.ask(session.sessionId, 'second?');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(space.getSessionState(session.sessionId).activeQuestion.questionId, second.questionId);
  assert.equal(
    errorCode(() => space.reply({ sessionId: session.sessionId, questionId: second.questionId, revision: first.revision, text: 'late' })),
    ERRORS.revisionMismatch
  );
  assert.equal(space.getSessionState(session.sessionId).status, 'needs-user');
  // The current revision still answers normally.
  space.reply({ sessionId: session.sessionId, questionId: second.questionId, revision: second.revision, text: 'now' });
  assert.equal(space.getSessionState(session.sessionId).status, 'working');
});

test('reply to closed session is rejected', () => {
  const space = createAgentSpace();
  const session = space.createSession();
  const question = space.ask(session.sessionId, 'q?');
  space.sendEvent(session.sessionId, { type: 'finished' });
  assert.equal(
    errorCode(() => space.reply({ sessionId: session.sessionId, questionId: question.questionId, revision: question.revision, text: 'r' })),
    ERRORS.sessionClosed
  );
  assert.equal(space.getSessionState(session.sessionId).status, 'finished');
});

test('repeated submission is rejected without duplicate side effects', () => {
  const space = createAgentSpace();
  const session = space.createSession();
  const question = space.ask(session.sessionId, 'q?');
  space.reply({ sessionId: session.sessionId, questionId: question.questionId, revision: question.revision, text: 'first' });
  // Same coordinates again: answered, not open -> rejected, state unchanged.
  assert.equal(
    errorCode(() => space.reply({ sessionId: session.sessionId, questionId: question.questionId, revision: question.revision, text: 'second' })),
    ERRORS.questionNotOpen
  );
  const state = space.getSessionState(session.sessionId);
  assert.equal(state.status, 'working');
  assert.equal(state.activeQuestion, null);
});

test('explicit events drive session states through the full lifecycle', () => {
  const space = createAgentSpace();
  const session = space.createSession();
  assert.equal(space.getSessionState(session.sessionId).status, 'working');
  const question = space.ask(session.sessionId, 'q?');
  assert.equal(space.getSessionState(session.sessionId).status, 'needs-user');
  space.sendEvent(session.sessionId, { type: 'working' });
  assert.equal(space.getSessionState(session.sessionId).status, 'working');
  space.sendEvent(session.sessionId, { type: 'needs-user' });
  assert.equal(space.getSessionState(session.sessionId).status, 'needs-user');
  space.reply({ sessionId: session.sessionId, questionId: question.questionId, revision: question.revision, text: 'ok' });
  assert.equal(space.getSessionState(session.sessionId).status, 'working');
  space.sendEvent(session.sessionId, { type: 'disconnected' });
  assert.equal(space.getSessionState(session.sessionId).status, 'disconnected');
  assert.equal(errorCode(() => space.ask(session.sessionId, 'too late?')), ERRORS.sessionClosed);
});

test('malformed events are rejected without corrupting state', () => {
  const space = createAgentSpace();
  const session = space.createSession();
  for (const event of [null, undefined, 'working', 42, [], { type: 'guess-from-text' }, { type: 'working', extra: true }, {}]) {
    assert.equal(errorCode(() => space.sendEvent(session.sessionId, event)), ERRORS.badEvent, `event ${JSON.stringify(event)}`);
  }
  // ask and reply also validate text/revision before touching state.
  assert.equal(errorCode(() => space.ask(session.sessionId, '')), ERRORS.badEvent);
  assert.equal(errorCode(() => space.reply({ sessionId: session.sessionId, questionId: 'question-1', revision: '1', text: 'r' })), ERRORS.revisionMismatch);
  assert.equal(space.getSessionState(session.sessionId).status, 'working');
  assert.ok(TERMINAL_STATES.has('finished') && TERMINAL_STATES.has('disconnected'));
});
