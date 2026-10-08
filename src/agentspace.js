'use strict';

/**
 * Agentspace core: sessions and questions with explicit reply routing.
 *
 * A session carries an explicit status driven only by caller-supplied events,
 * never by guessing from message text. A question belongs to exactly one
 * session, has a unique id and a revision, and can be answered or become
 * stale. A reply must name the exact active question id and revision.
 * No subprocess execution, no network, no telemetry.
 */

// A plain object literal inherits Object.prototype members, so a `type` of
// 'toString', 'constructor' or any other inherited name would resolve to a
// function and pass the earlier `status === undefined` check, writing that
// function into session.status. Own keys only.
const STATE_EVENT_TYPES = Object.assign(Object.create(null), {
  working: 'working',
  'needs-user': 'needs-user',
  finished: 'finished',
  disconnected: 'disconnected',
});

const TERMINAL_STATES = new Set(['finished', 'disconnected']);
const STATUSES = new Set(['working', 'needs-user', ...TERMINAL_STATES]);

/** Errors are distinguished by name so callers can route on them. */
const ERRORS = {
  unknownSession: 'unknownSession',
  sessionClosed: 'sessionClosed',
  unknownQuestion: 'unknownQuestion',
  questionNotOpen: 'questionNotOpen',
  revisionMismatch: 'revisionMismatch',
  badEvent: 'badEvent',
  sessionHasOpenQuestion: 'sessionHasOpenQuestion',
};

let nextId = 1;

function newId(prefix) {
  const id = `${prefix}-${nextId}`;
  nextId += 1;
  return id;
}

class AgentSpaceError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function fail(name, message) {
  throw new AgentSpaceError(name, message);
}

/**
 * An empty AgentSpace. Sessions are stored in memory, keyed by session id.
 */
function createAgentSpace() {
  const sessions = new Map();

  /** Create a session. New sessions start in the explicit 'working' state. */
  function createSession() {
    const session = {
      id: newId('session'),
      status: 'working',
      questions: new Map(), // questionId -> question
      activeQuestionId: null,
      lastRevision: 0,
    };
    sessions.set(session.id, session);
    return { sessionId: session.id, status: session.status };
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) fail(ERRORS.unknownSession, `no session ${sessionId}`);
    return session;
  }

  function assertOpen(session) {
    if (TERMINAL_STATES.has(session.status)) {
      fail(ERRORS.sessionClosed, `session ${session.id} is ${session.status}`);
    }
  }

  /** Ask a question in a session. Supersedes (stales) the previous open question. */
  function ask(sessionId, text) {
    if (typeof text !== 'string' || text.length === 0) {
      fail(ERRORS.badEvent, 'question text must be a non-empty string');
    }
    const session = getSession(sessionId);
    assertOpen(session);
    if (session.activeQuestionId) {
      session.questions.get(session.activeQuestionId).status = 'stale';
      session.activeQuestionId = null;
    }
    session.lastRevision += 1;
    const question = {
      id: newId('question'),
      sessionId: session.id,
      revision: session.lastRevision,
      text,
      status: 'open', // open | answered | stale
    };
    session.questions.set(question.id, question);
    session.activeQuestionId = question.id;
    session.status = 'needs-user';
    return { sessionId: session.id, questionId: question.id, revision: question.revision, status: question.status };
  }

  /**
   * Reply to a question. The reply targets the exact session, the exact
   * active question and its exact revision; anything else is rejected
   * before any state changes.
   */
  function reply({ sessionId, questionId, revision, text }) {
    if (typeof text !== 'string' || text.length === 0) {
      fail(ERRORS.badEvent, 'reply text must be a non-empty string');
    }
    if (!Number.isInteger(revision)) {
      fail(ERRORS.revisionMismatch, `revision must be an integer, got ${revision}`);
    }
    const session = getSession(sessionId);
    assertOpen(session);
    if (!questionId || !session.questions.has(questionId)) {
      fail(ERRORS.unknownQuestion, `session ${session.id} has no question ${questionId}`);
    }
    const question = session.questions.get(questionId);
    if (question.status !== 'open') {
      fail(ERRORS.questionNotOpen, `question ${questionId} is ${question.status}`);
    }
    if (question.revision !== revision) {
      fail(ERRORS.revisionMismatch, `question ${questionId} is at revision ${question.revision}, reply targeted ${revision}`);
    }
    if (session.activeQuestionId !== questionId) {
      fail(ERRORS.questionNotOpen, `question ${questionId} is not the active question of session ${session.id}`);
    }
    question.status = 'answered';
    session.activeQuestionId = null;
    session.status = 'working';
    return { sessionId: session.id, questionId: question.id, status: question.status };
  }

  /**
   * Apply an explicit state event to a session. Only the four known event
   * kinds are accepted; malformed events are rejected before any state
   * changes. Terminal events close the session to further asks and replies.
   */
  function sendEvent(sessionId, event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      fail(ERRORS.badEvent, 'event must be an object with a type');
    }
    const status = STATE_EVENT_TYPES[event.type];
    if (typeof status !== 'string' || Object.keys(event).some((key) => key !== 'type')) {
      fail(ERRORS.badEvent, `unknown event ${JSON.stringify(event)}`);
    }
    const session = getSession(sessionId);
    assertOpen(session);
    session.status = status;
    return { sessionId: session.id, status: session.status };
  }

  /** Read-only view of a session, for callers and tests. */
  function getSessionState(sessionId) {
    const session = getSession(sessionId);
    const active = session.activeQuestionId ? session.questions.get(session.activeQuestionId) : null;
    return {
      sessionId: session.id,
      status: session.status,
      activeQuestion: active
        ? { questionId: active.id, revision: active.revision, text: active.text, status: active.status }
        : null,
    };
  }

  /** List sessions, optionally filtered by a status. Ordered by creation. */
  function listSessions(filterStatus) {
    if (filterStatus !== undefined && !STATUSES.has(filterStatus)) {
      fail(ERRORS.badEvent, `unknown session status ${JSON.stringify(filterStatus)}`);
    }
    const out = [];
    for (const session of sessions.values()) {
      const active = session.activeQuestionId ? session.questions.get(session.activeQuestionId) : null;
      if (filterStatus !== undefined && session.status !== filterStatus) continue;
      out.push({
        sessionId: session.id,
        status: session.status,
        hasPendingQuestion: active !== null,
      });
    }
    return out;
  }

  /** Questions awaiting a reply, optionally scoped to one session. Ordered by revision. */
  function listPendingQuestions(sessionId) {
    const scoped = sessionId === undefined ? [...sessions.values()] : [getSession(sessionId)];
    const out = [];
    for (const session of scoped) {
      if (!session.activeQuestionId) continue;
      const q = session.questions.get(session.activeQuestionId);
      out.push({ sessionId: session.id, questionId: q.id, revision: q.revision, text: q.text });
    }
    out.sort((a, b) => a.revision - b.revision || a.sessionId.localeCompare(b.sessionId));
    return out;
  }

  return { createSession, ask, reply, sendEvent, getSessionState, listSessions, listPendingQuestions };
}

module.exports = { createAgentSpace, AgentSpaceError, ERRORS, STATE_EVENT_TYPES, TERMINAL_STATES };
