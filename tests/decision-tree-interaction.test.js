const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id;
    this.className = "";
    this.listeners = {};
    this.style = {};
    this._innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

function loadApp() {
  const html = readFileSync(new URL("../index.html", `file://${__filename}`), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = {
    app: new Element("app"),
    breadcrumb: new Element("breadcrumb"),
    "question-card": new Element("question-card"),
    "result-card": new Element("result-card"),
    "progress-fill": new Element("progress-fill"),
    "restart-btn": new Element("restart-btn"),
  };

  const context = {
    document: {
      getElementById(id) {
        const element = elements[id];
        if (!element) {
          throw new Error(`Missing test element: ${id}`);
        }
        return element;
      },
    },
  };

  vm.runInNewContext(script, context);

  return { context, elements };
}

test("stale result-producing option replays do not crash after a result is shown", () => {
  const { context, elements } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  assert.equal(elements["result-card"].style.display, "");
  assert.match(elements["result-card"].innerHTML, /Siinus rütm/);

  assert.doesNotThrow(() => {
    context.handleAnswer("Normaalne", "result-sinus");
  });
  assert.equal(elements["result-card"].style.display, "");
  assert.match(elements["result-card"].innerHTML, /Siinus rütm/);
});

test("stale options from a prior question do not corrupt the current path", () => {
  const { context, elements } = loadApp();

  context.handleAnswer("Ei", "no-p-wave");
  assert.match(elements["question-card"].innerHTML, /Samm 2/);
  assert.equal(elements["progress-fill"].style.width, "25%");
  const breadcrumbAfterFirstAnswer = elements.breadcrumb.innerHTML;

  context.handleAnswer("Ei", "no-p-wave");

  assert.match(elements["question-card"].innerHTML, /Samm 2/);
  assert.equal(elements["progress-fill"].style.width, "25%");
  assert.equal(elements.breadcrumb.innerHTML, breadcrumbAfterFirstAnswer);
});
