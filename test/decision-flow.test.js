const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function createElement(id, onQuestionMarkup) {
  const listeners = {};
  let html = "";

  return {
    id,
    style: {},
    className: "",
    listeners,
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      if (id === "question-card") {
        onQuestionMarkup(value);
      }
    },
  };
}

function extractButtons(markup) {
  const buttons = [];
  const re = /<button class="option-btn" data-next="([^"]+)" data-label="([^"]+)"( disabled)?>(.*?)<\/button>/g;
  let match;

  while ((match = re.exec(markup)) !== null) {
    buttons.push({
      disabled: Boolean(match[3]),
      dataset: {
        next: match[1],
        label: match[2],
      },
      closest(selector) {
        return selector === ".option-btn" ? this : null;
      },
    });
  }

  return buttons;
}

function loadApp() {
  const html = fs.readFileSync("index.html", "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const timers = new Map();
  const elements = new Map();
  let nextTimerId = 1;
  let optionButtons = [];

  function setQuestionMarkup(markup) {
    optionButtons = extractButtons(markup);
  }

  for (const id of ["app", "breadcrumb", "question-card", "result-card", "restart-btn", "progress-fill"]) {
    elements.set(id, createElement(id, setQuestionMarkup));
  }

  const document = {
    getElementById(id) {
      const element = elements.get(id);
      if (!element) {
        throw new Error(`Unexpected element lookup: ${id}`);
      }
      return element;
    },
    querySelectorAll(selector) {
      return selector === ".option-btn" ? optionButtons : [];
    },
  };

  const context = {
    document,
    setTimeout(handler, delay) {
      const id = nextTimerId++;
      timers.set(id, { handler, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  vm.createContext(context);
  vm.runInContext(script, context);

  return {
    context,
    elements,
    get optionButtons() {
      return optionButtons;
    },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(timer => timer.handler());
    },
  };
}

test("rapid repeated answers cannot advance multiple decision steps", () => {
  const app = loadApp();
  const questionCard = app.elements.get("question-card");
  const click = app.elements.get("app").listeners.click;

  assert.match(questionCard.innerHTML, /Samm 1/);

  click({ target: app.optionButtons[0] });

  assert.match(questionCard.innerHTML, /Samm 2/);
  assert.match(questionCard.innerHTML, /Kas P-laine on ALATI seotud/);
  assert.equal(app.optionButtons.every(btn => btn.disabled), true);

  click({ target: app.optionButtons[0] });

  assert.match(questionCard.innerHTML, /Samm 2/);
  assert.match(questionCard.innerHTML, /Kas P-laine on ALATI seotud/);

  app.runTimers();
  assert.equal(app.optionButtons.every(btn => !btn.disabled), true);

  click({ target: app.optionButtons[0] });

  assert.match(questionCard.innerHTML, /Samm 3/);
  assert.match(questionCard.innerHTML, /Milline on PR-intervall/);
});
