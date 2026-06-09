const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.className = "";
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];

    const buttonPattern = /<button class="option-btn" data-next="([^"]+)" data-label="([^"]+)">([^<]+)<\/button>/g;
    let match;
    while ((match = buttonPattern.exec(value)) !== null) {
      this.children.push(new FakeButton(match[2], match[1], match[3]));
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }
}

class FakeButton extends FakeElement {
  constructor(label, next, text) {
    super(null);
    this.className = "option-btn";
    this.dataset = { label, next };
    this.textContent = text;
  }

  closest(selector) {
    return selector === ".option-btn" ? this : null;
  }
}

function loadApp() {
  const html = readFileSync("index.html", "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map(
    ["app", "breadcrumb", "question-card", "result-card", "restart-btn", "progress-fill"].map(id => [
      id,
      new FakeElement(id)
    ])
  );

  const document = {
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `Expected fixture element #${id}`);
      return element;
    }
  };

  vm.runInNewContext(script, { document }, { filename: "index.html" });

  return {
    elements,
    clickOption(label) {
      const questionCard = elements.get("question-card");
      const button = questionCard.children.find(child => child.dataset.label === label);
      assert.ok(button, `Expected option "${label}" to be rendered`);
      elements.get("app").listeners.click({ target: button });
    }
  };
}

test("shows the diagnosis result after completing a decision path", () => {
  const app = loadApp();

  app.clickOption("Jah, normaalne");
  app.clickOption("Jah");
  app.clickOption("Normaalne");

  const resultCard = app.elements.get("result-card");
  assert.equal(app.elements.get("question-card").style.display, "none");
  assert.equal(resultCard.style.display, "block");
  assert.match(resultCard.innerHTML, /Siinus rütm/);
  assert.match(resultCard.className, /result--normal/);
  assert.equal(app.elements.get("progress-fill").style.width, "100%");
});
