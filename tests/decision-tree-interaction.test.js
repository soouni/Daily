const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = '';
    this.listeners = {};
    this._innerHTML = '';
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

function createDocument() {
  const elements = new Map();
  for (const id of ['app', 'breadcrumb', 'question-card', 'result-card', 'restart-btn', 'progress-fill']) {
    elements.set(id, new FakeElement(id));
  }

  return {
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `Unexpected element lookup: ${id}`);
      return element;
    }
  };
}

function createTimers() {
  const pending = new Set();

  return {
    setTimeout(callback) {
      pending.add(callback);
      return callback;
    },

    clearTimeout(callback) {
      pending.delete(callback);
    },

    runAll() {
      for (const callback of Array.from(pending)) {
        pending.delete(callback);
        callback();
      }
    }
  };
}

function loadApp() {
  const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const timers = createTimers();
  const context = {
    document: createDocument(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    runTimers: timers.runAll
  };

  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

test('valid decision path renders a result', () => {
  const app = loadApp();

  app.handleAnswer('Jah, normaalne', 'p-always-related');
  app.runTimers();
  app.handleAnswer('Jah', 'pr-interval');
  app.runTimers();
  app.handleAnswer('Normaalne', 'result-sinus');

  const questionCard = app.document.getElementById('question-card');
  const resultCard = app.document.getElementById('result-card');
  const progress = app.document.getElementById('progress-fill');

  assert.equal(questionCard.style.display, 'none');
  assert.equal(resultCard.style.display, '');
  assert.match(resultCard.innerHTML, /Siinus rütm/);
  assert.equal(progress.style.width, '100%');
});

test('rapid repeated activation cannot skip the next question', () => {
  const app = loadApp();

  app.handleAnswer('Jah, normaalne', 'p-always-related');
  const breadcrumbBefore = app.document.getElementById('breadcrumb').innerHTML;
  const questionBefore = app.document.getElementById('question-card').innerHTML;

  app.handleAnswer('Jah', 'pr-interval');

  assert.equal(app.document.getElementById('breadcrumb').innerHTML, breadcrumbBefore);
  assert.equal(app.document.getElementById('question-card').innerHTML, questionBefore);

  app.runTimers();
  app.handleAnswer('Jah', 'pr-interval');
  assert.match(app.document.getElementById('question-card').innerHTML, /PR-intervall/);
});

test('stale result option activation is ignored instead of crashing', () => {
  const app = loadApp();

  app.handleAnswer('Jah, normaalne', 'p-always-related');
  app.runTimers();
  app.handleAnswer('Jah', 'pr-interval');
  app.runTimers();
  app.handleAnswer('Normaalne', 'result-sinus');

  const breadcrumbBefore = app.document.getElementById('breadcrumb').innerHTML;
  const resultBefore = app.document.getElementById('result-card').innerHTML;

  assert.doesNotThrow(() => {
    app.handleAnswer('Normaalne', 'result-sinus');
  });

  assert.equal(app.document.getElementById('breadcrumb').innerHTML, breadcrumbBefore);
  assert.equal(app.document.getElementById('result-card').innerHTML, resultBefore);
});

test('stale option from previous question is ignored', () => {
  const app = loadApp();

  app.handleAnswer('Jah, normaalne', 'p-always-related');
  app.runTimers();
  const breadcrumbBefore = app.document.getElementById('breadcrumb').innerHTML;
  const questionBefore = app.document.getElementById('question-card').innerHTML;

  app.handleAnswer('Jah, normaalne', 'p-always-related');

  assert.equal(app.document.getElementById('breadcrumb').innerHTML, breadcrumbBefore);
  assert.equal(app.document.getElementById('question-card').innerHTML, questionBefore);
});
