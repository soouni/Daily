const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement(id) {
  return {
    id,
    style: {},
    className: "",
    innerHTML: "",
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, "index.html should contain an inline script");

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement(id));
      }
      return elements.get(id);
    },
  };

  const context = vm.createContext({ document });
  vm.runInContext(scriptMatch[1], context);

  return { context, document };
}

test("completed ECG path shows the diagnosis result card", () => {
  const { context, document } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  const questionCard = document.getElementById("question-card");
  const resultCard = document.getElementById("result-card");

  assert.equal(questionCard.style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.innerHTML, /Siinus rütm/);
});
