const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = "";
    this.listeners = {};
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

function loadAppScript() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "index.html should contain the app script");

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, new Element(id));
      }
      return elements.get(id);
    }
  };

  const context = { document };
  vm.runInNewContext(match[1], context);

  return { context, elements };
}

test("a completed decision path shows the result card", () => {
  const { context, elements } = loadAppScript();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  const questionCard = elements.get("question-card");
  const resultCard = elements.get("result-card");

  assert.equal(questionCard.style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.innerHTML, /Siinus rütm/);
  assert.equal(elements.get("progress-fill").style.width, "100%");
});
