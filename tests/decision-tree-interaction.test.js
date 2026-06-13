const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  return {
    style: {},
    className: "",
    innerHTML: "",
    addEventListener() {}
  };
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const [, script] = html.match(/<script>([\s\S]*)<\/script>/);
  const elements = {
    app: createElement(),
    breadcrumb: createElement(),
    "question-card": createElement(),
    "result-card": createElement(),
    "progress-fill": createElement(),
    "restart-btn": createElement()
  };
  const context = {
    document: {
      getElementById(id) {
        return elements[id];
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: "index.html" });

  return { context, elements };
}

test("completed decision path shows the result card", () => {
  const { context, elements } = loadApp();

  context.handleAnswer("Jah, normaalne", "p-always-related");
  context.handleAnswer("Jah", "pr-interval");
  context.handleAnswer("Normaalne", "result-sinus");

  assert.equal(elements["question-card"].style.display, "none");
  assert.equal(elements["result-card"].style.display, "block");
  assert.match(elements["result-card"].innerHTML, /Siinus rütm/);
  assert.equal(elements["progress-fill"].style.width, "100%");
});
