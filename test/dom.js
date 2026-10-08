'use strict';

/**
 * Minimal fake DOM for exercising src/page.js's client module through its
 * real behavior with fixtures instead of copies of its logic. Nodes track
 * their children and only ever expose text through textContent; setting
 * innerHTML fails, so any move to HTML parsing in the page script cannot
 * pass even these fixtures.
 */

function node(tagName) {
  const item = {
    tagName: tagName.toUpperCase(),
    listeners: {},
    attributes: {},
    children: [],
    parent: null,
    appendChild(child) {
      child.parent = item;
      item.children.push(child);
    },
    addEventListener(type, fn) {
      item.listeners[type] = fn;
    },
    click() {
      if (!item.listeners.click) throw new Error('no click listener on ' + tagName + ' node');
      return item.listeners.click.call(item, { preventDefault() {} });
    },
    setAttribute(key, value) {
      item.attributes[key] = value;
    },
    get textContent() {
      return item._text;
    },
    set textContent(value) {
      if (typeof value !== 'string') throw new Error('textContent accepts text only');
      item._text = value;
      item.children = [];
    },
  };
  item._text = '';
  Object.defineProperty(item, 'innerHTML', {
    set() { throw new Error('innerHTML must not be used: untrusted data stays text'); },
  });
  return item;
}

/** Build `{ elements, sandbox }` with the ids the page script touches. */
function createSandbox(ids) {
  const elements = {};
  for (const id of ids) elements[id] = node(id === 'token' ? 'input' : 'p');
  const document = {
    getElementById(id) {
      if (!Object.prototype.hasOwnProperty.call(elements, id)) return null;
      return elements[id];
    },
    createElement(tagName) {
      return node(tagName);
    },
  };
  const sandbox = { document };
  sandbox.globalThis = sandbox;
  return { elements, sandbox };
}

module.exports = { node, createSandbox };
