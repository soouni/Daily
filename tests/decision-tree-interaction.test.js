const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

class StubElement {
  constructor(id) {
    this.id = id;
    this.className = "";
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this._innerHTML = "";
  }

  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }

  closest(selector) {
    return selector === ".option-btn" && this.className.includes("option-btn") ? this : null;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }
}

function createHarness() {
  const elements = {};
  const timers = [];

  const context = {
    document: {
      getElementById(id) {
        elements[id] ??= new StubElement(id);
        return elements[id];
      }
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context);

  return {
    context,
    elements,
    runTimers() {
      while (timers.length) timers.shift()();
    }
  };
}

test("ignores replayed terminal answers instead of crashing", () => {
  const { context, elements, runTimers } = createHarness();

  context.handleAnswer("Ei", "no-p-wave");
  runTimers();
  context.handleAnswer("Puudub", "result-vf");

  assert.doesNotThrow(() => context.handleAnswer("Puudub", "result-vf"));
  assert.match(elements["result-card"].innerHTML, /VF \//);
});

test("rejects stale options from a previous question", () => {
  const { context, elements, runTimers } = createHarness();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  runTimers();
  const breadcrumbAfterFirstAnswer = elements.breadcrumb.innerHTML;

  context.handleAnswer("Jah, normaalne", "p-always-related");

  assert.equal(elements.breadcrumb.innerHTML, breadcrumbAfterFirstAnswer);
});

test("locks rapid follow-up answers until the next question is stable", () => {
  const { context, elements, runTimers } = createHarness();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Ei", "p-sometimes");
  const breadcrumbAfterRapidAnswer = elements.breadcrumb.innerHTML;

  runTimers();
  context.handleAnswer("Ei", "p-sometimes");

  assert.notEqual(elements.breadcrumb.innerHTML, breadcrumbAfterRapidAnswer);
});
