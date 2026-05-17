const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = "";
    this._innerHTML = "";
    this.listeners = {};
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const timers = [];

  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  }

  const context = {
    document: { getElementById },
    window: {
      setTimeout(callback) {
        timers.push(callback);
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: "index.html" });

  return {
    context,
    element: getElementById,
    flushTimers() {
      while (timers.length) timers.shift()();
    }
  };
}

function testRapidSecondAnswerIsIgnoredDuringTransition() {
  const app = loadApp();

  app.context.handleAnswer("Jah, normaalne", "p-always-related");
  app.context.handleAnswer("Jah", "pr-interval");

  assert.match(
    app.element("question-card").innerHTML,
    /Kas P-laine on ALATI seotud QRS-kompleksiga\?/,
    "a rapid second activation should not answer the newly rendered question"
  );

  app.flushTimers();
  app.context.handleAnswer("Jah", "pr-interval");

  assert.match(
    app.element("question-card").innerHTML,
    /Milline on PR-intervall\?/,
    "the current option should work after the transition lock clears"
  );
}

function testStaleResultOptionDoesNotCrashOrChangeResult() {
  const app = loadApp();

  app.context.handleAnswer("Jah, normaalne", "p-always-related");
  app.flushTimers();
  app.context.handleAnswer("Jah", "pr-interval");
  app.flushTimers();
  app.context.handleAnswer("Normaalne", "result-sinus");
  app.flushTimers();

  assert.match(app.element("result-card").innerHTML, /Siinus rütm/);

  assert.doesNotThrow(() => {
    app.context.handleAnswer("Normaalne", "result-sinus");
  });
  assert.match(
    app.element("result-card").innerHTML,
    /Siinus rütm/,
    "a replayed answer after a result should leave the result intact"
  );
}

testRapidSecondAnswerIsIgnoredDuringTransition();
testStaleResultOptionDoesNotCrashOrChangeResult();

