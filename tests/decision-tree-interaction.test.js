const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = "";
    this.listeners = {};
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

function loadApp() {
  const elements = new Map([
    "app",
    "breadcrumb",
    "question-card",
    "result-card",
    "restart-btn",
    "progress-fill"
  ].map(id => [id, new FakeElement(id)]));

  const document = {
    getElementById(id) {
      const element = elements.get(id);
      if (!element) {
        throw new Error(`Unexpected element lookup: ${id}`);
      }
      return element;
    }
  };

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const context = vm.createContext({ document });
  vm.runInContext(script, context);

  return { context, document };
}

test("ignores a stale option replay after advancing to another question", () => {
  const { context, document } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  const questionBeforeReplay = document.getElementById("question-card").innerHTML;
  const breadcrumbBeforeReplay = document.getElementById("breadcrumb").innerHTML;

  context.handleAnswer("Jah, normaalne", "p-always-related");

  assert.equal(document.getElementById("question-card").innerHTML, questionBeforeReplay);
  assert.equal(document.getElementById("breadcrumb").innerHTML, breadcrumbBeforeReplay);
});

test("ignores a stale option replay after a result is rendered", () => {
  const { context, document } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Ei", "p-sometimes");
  context.handleAnswer("Mõnikord", "result-av2");

  const resultBeforeReplay = document.getElementById("result-card").innerHTML;
  const breadcrumbBeforeReplay = document.getElementById("breadcrumb").innerHTML;
  assert.match(resultBeforeReplay, /II astme AV blokaad/);

  assert.doesNotThrow(() => context.handleAnswer("Mitte kunagi", "p-never"));
  assert.equal(document.getElementById("result-card").innerHTML, resultBeforeReplay);
  assert.equal(document.getElementById("breadcrumb").innerHTML, breadcrumbBeforeReplay);
});
