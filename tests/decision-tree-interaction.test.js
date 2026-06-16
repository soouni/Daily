const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

class FakeElement {
  constructor(id) {
    this.id = id;
    this.className = "";
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this._innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  closest(selector) {
    return selector === ".option-btn" && this.className === "option-btn" ? this : null;
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML;
  }
}

function loadApp() {
  const html = readFileSync("index.html", "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = {
    app: new FakeElement("app"),
    breadcrumb: new FakeElement("breadcrumb"),
    "question-card": new FakeElement("question-card"),
    "result-card": new FakeElement("result-card"),
    "progress-fill": new FakeElement("progress-fill"),
    "restart-btn": new FakeElement("restart-btn")
  };

  const context = {
    document: {
      getElementById(id) {
        return elements[id];
      }
    }
  };

  vm.runInNewContext(script, context);

  return elements;
}

function answer(elements, label, next) {
  const target = new FakeElement("answer");
  target.className = "option-btn";
  target.dataset = { label, next };
  elements.app.listeners.click({ target });
}

test("complete decision path shows the sinus rhythm result", () => {
  const elements = loadApp();

  answer(elements, "Jah, normaalne", "p-always-related");
  answer(elements, "Jah", "pr-interval");
  answer(elements, "Normaalne", "result-sinus");

  assert.equal(elements["question-card"].style.display, "none");
  assert.equal(elements["result-card"].style.display, "block");
  assert.match(elements["result-card"].innerHTML, /Siinus rütm/);
  assert.equal(elements["progress-fill"].style.width, "100%");
});
