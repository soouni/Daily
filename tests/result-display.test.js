const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = id === "question-card" || id === "result-card" ? "card" : "";
    this.innerHTML = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

function loadApp() {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "Expected index.html to contain the app script");

  const elements = Object.fromEntries(
    [
      "app",
      "breadcrumb",
      "question-card",
      "result-card",
      "progress-fill",
      "restart-btn"
    ].map(id => [id, new FakeElement(id)])
  );

  const context = {
    document: {
      getElementById(id) {
        assert.ok(elements[id], `Unexpected element lookup: ${id}`);
        return elements[id];
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(
    `${script}\nglobalThis.__testApi = { handleAnswer, handleRestart };`,
    context,
    { filename: "index.html" }
  );

  return { elements, api: context.__testApi };
}

test("a complete decision path shows the diagnosis result card", () => {
  const { elements, api } = loadApp();

  api.handleAnswer("normal P wave", "p-always-related");
  api.handleAnswer("always related", "pr-interval");
  api.handleAnswer("normal PR interval", "result-sinus");

  assert.equal(elements["question-card"].style.display, "none");
  assert.equal(elements["result-card"].style.display, "block");
  assert.equal(elements["result-card"].className, "card result--normal");
  assert.match(elements["result-card"].innerHTML, /Siinus/);
  assert.equal(elements["progress-fill"].style.width, "100%");
});
