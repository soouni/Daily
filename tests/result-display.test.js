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
    listeners: {},
    _innerHTML: "",
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    set innerHTML(value) {
      this._innerHTML = value;
    },
    get innerHTML() {
      return this._innerHTML;
    }
  };
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const elements = new Map(
    ["app", "breadcrumb", "question-card", "result-card", "progress-fill", "restart-btn"].map(id => [
      id,
      createElement(id)
    ])
  );
  const document = {
    getElementById(id) {
      const element = elements.get(id);
      assert.ok(element, `Unexpected element lookup: ${id}`);
      return element;
    }
  };
  const context = vm.createContext({ document });

  vm.runInContext(script, context);

  return { elements };
}

function clickOption(elements, label) {
  const app = elements.get("app");
  const questionCard = elements.get("question-card");
  const options = [...questionCard.innerHTML.matchAll(/data-next="([^"]+)" data-label="([^"]+)">([^<]+)<\/button>/g)];
  const option = options.find(match => match[2] === label || match[3] === label);

  assert.ok(option, `Option not found: ${label}`);

  const [, next, dataLabel] = option;
  const button = {
    dataset: { label: dataLabel, next },
    closest(selector) {
      return selector === ".option-btn" ? button : null;
    }
  };

  app.listeners.click({ target: button });
}

test("a complete decision path renders a visible result card", () => {
  const { elements } = loadApp();

  clickOption(elements, "Jah, normaalne");
  clickOption(elements, "Jah");
  clickOption(elements, "Normaalne");

  const resultCard = elements.get("result-card");
  assert.equal(resultCard.style.display, "block");
  assert.equal(elements.get("question-card").style.display, "none");
  assert.match(resultCard.className, /\bresult--normal\b/);
  assert.match(resultCard.innerHTML, /Siinus rütm/);
  assert.equal(elements.get("progress-fill").style.width, "100%");
});
