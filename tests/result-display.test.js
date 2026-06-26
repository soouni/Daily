const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = "";
    this.listeners = new Map();
    this._innerHTML = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

function createDocument() {
  const elements = new Map(
    ["app", "breadcrumb", "question-card", "result-card", "progress-fill", "restart-btn"]
      .map(id => [id, new Element(id)])
  );

  return {
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `Unexpected element lookup: ${id}`);
      return element;
    }
  };
}

function loadApp(document) {
  const indexPath = path.join(__dirname, "..", "index.html");
  const html = readFileSync(indexPath, "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const context = { document };

  vm.runInNewContext(script, context);

  return context;
}

test("a completed decision path displays its rhythm result", () => {
  const document = createDocument();
  const app = loadApp(document);

  app.handleAnswer("Jah, normaalne", "p-always-related");
  app.handleAnswer("Jah", "pr-interval");
  app.handleAnswer("Normaalne", "result-sinus");

  const questionCard = document.getElementById("question-card");
  const resultCard = document.getElementById("result-card");

  assert.equal(questionCard.style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.innerHTML, /Siinus/);
});
