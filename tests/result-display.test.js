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
    addEventListener() {}
  };
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map();

  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement(id));
      }
      return elements.get(id);
    }
  };

  const context = { document };
  vm.createContext(context);
  vm.runInContext(script, context);

  return { context, document };
}

test("completed decision path displays the result card", () => {
  const { context, document } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  const resultCard = document.getElementById("result-card");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.innerHTML, /Siinus rütm/);
});
