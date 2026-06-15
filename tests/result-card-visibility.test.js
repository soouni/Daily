const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractScript(source) {
  const match = source.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "expected index.html to contain an inline script");
  return match[1];
}

function createDocument() {
  const elements = new Map();

  for (const id of [
    "app",
    "breadcrumb",
    "question-card",
    "result-card",
    "progress-fill",
    "restart-btn",
  ]) {
    elements.set(id, {
      id,
      style: {},
      className: "",
      innerHTML: "",
      listeners: {},
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
    });
  }

  return {
    elements,
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `unexpected element lookup: ${id}`);
      return element;
    },
  };
}

test("result card is explicitly shown when a diagnosis is rendered", () => {
  assert.match(
    html,
    /#result-card\s*\{[^}]*display:\s*none;/,
    "the stylesheet hides the result card until a diagnosis is rendered",
  );

  const document = createDocument();
  const context = vm.createContext({ document });

  vm.runInContext(extractScript(html), context);

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  const questionCard = document.elements.get("question-card");
  const resultCard = document.elements.get("result-card");

  assert.equal(questionCard.style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.className, /\bresult--normal\b/);
  assert.match(resultCard.innerHTML, /Siinus rütm/);
});
