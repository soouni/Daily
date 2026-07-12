const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeButton {
  constructor(next, label) {
    this.dataset = { next, label };
  }

  closest(selector) {
    return selector === ".option-btn" ? this : null;
  }
}

class FakeElement {
  constructor() {
    this.className = "";
    this.listeners = {};
    this.style = {};
    this.textContent = "";
    this.buttons = [];
    this._innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.textContent = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    this.buttons = [];

    const buttonPattern = /<button class="option-btn" data-next="([^"]+)" data-label="([^"]+)">/g;
    let match;
    while ((match = buttonPattern.exec(value)) !== null) {
      this.buttons.push(new FakeButton(match[1], match[2]));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

function loadApp() {
  const elements = new Map();
  for (const id of ["app", "breadcrumb", "question-card", "result-card", "progress-fill", "restart-btn"]) {
    elements.set(id, new FakeElement());
  }

  const document = {
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `Unexpected element lookup: ${id}`);
      return element;
    }
  };

  const context = { document };
  context.window = context;

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, context, { filename: "index.html" });

  return {
    elements,
    click(button) {
      elements.get("app").listeners.click({ target: button });
    }
  };
}

test("a completed decision path makes the diagnosis card visible", () => {
  const app = loadApp();
  const questionCard = app.elements.get("question-card");
  const resultCard = app.elements.get("result-card");

  app.click(questionCard.buttons.find(button => button.dataset.label === "Jah, normaalne"));
  app.click(questionCard.buttons.find(button => button.dataset.label === "Jah"));
  app.click(questionCard.buttons.find(button => button.dataset.label === "Normaalne"));

  assert.equal(questionCard.style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.textContent, /Siinus rütm/);
});
