const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(id) {
    this.id = id;
    this.className = "";
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this._innerHTML = "";
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  dispatchClick(target) {
    this.listeners.click({ target });
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }
}

class OptionButton {
  constructor(label, next) {
    this.dataset = { label, next };
  }

  closest(selector) {
    return selector === ".option-btn" ? this : null;
  }
}

function createApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map([
    ["app", new Element("app")],
    ["breadcrumb", new Element("breadcrumb")],
    ["question-card", new Element("question-card")],
    ["result-card", new Element("result-card")],
    ["progress-fill", new Element("progress-fill")],
    ["restart-btn", new Element("restart-btn")],
  ]);
  const document = {
    getElementById(id) {
      const element = elements.get(id);
      if (!element) {
        throw new Error(`Missing test element: ${id}`);
      }
      return element;
    },
  };

  vm.runInNewContext(script, { document });

  return {
    app: elements.get("app"),
    breadcrumb: elements.get("breadcrumb"),
    questionCard: elements.get("question-card"),
    resultCard: elements.get("result-card"),
  };
}

function option(label, next) {
  return new OptionButton(label, next);
}

function breadcrumbCount(html) {
  return (html.match(/class="chip"/g) || []).length;
}

test("ignores stale option clicks from a previous question", () => {
  const { app, breadcrumb, questionCard } = createApp();
  const rootAnswer = option("Jah, normaalne", "p-always-related");

  app.dispatchClick(rootAnswer);
  app.dispatchClick(rootAnswer);

  assert.equal(breadcrumbCount(breadcrumb.innerHTML), 1);
  assert.match(questionCard.innerHTML, /Kas P-laine on ALATI seotud QRS-kompleksiga\?/);
});

test("ignores duplicate result-bound clicks after reaching a result", () => {
  const { app, breadcrumb, resultCard } = createApp();
  const rootAnswer = option("Jah, normaalne", "p-always-related");
  const relationAnswer = option("Jah", "pr-interval");
  const resultAnswer = option("Normaalne", "result-sinus");

  app.dispatchClick(rootAnswer);
  app.dispatchClick(relationAnswer);
  app.dispatchClick(resultAnswer);

  assert.doesNotThrow(() => app.dispatchClick(resultAnswer));
  assert.equal(breadcrumbCount(breadcrumb.innerHTML), 3);
  assert.match(resultCard.innerHTML, /Siinus rütm/);
});
