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
  constructor(id) {
    this.id = id;
    this.className = "";
    this.style = {};
    this.listeners = {};
    this.buttons = [];
    this._innerHTML = "";
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  set innerHTML(value) {
    this._innerHTML = value;
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

function setupApp() {
  const elements = new Map();
  for (const id of ["app", "breadcrumb", "question-card", "result-card", "progress-fill", "restart-btn"]) {
    elements.set(id, new FakeElement(id));
  }

  const timers = [];
  const document = {
    getElementById(id) {
      return elements.get(id);
    }
  };

  const context = {
    console,
    document,
    window: {
      setTimeout(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      }
    }
  };
  context.window.document = document;

  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, context, { filename: "index.html" });

  return {
    elements,
    click(button) {
      elements.get("app").listeners.click({ target: button });
    },
    runTimers() {
      while (timers.length) {
        timers.shift().callback();
      }
    }
  };
}

test("rapid duplicate clicks do not answer the next question implicitly", () => {
  const app = setupApp();
  const questionCard = app.elements.get("question-card");

  app.click(questionCard.buttons[0]);
  assert.match(questionCard.innerHTML, /Kas P-laine on ALATI seotud QRS-kompleksiga\?/);

  app.click(questionCard.buttons[0]);
  assert.match(questionCard.innerHTML, /Kas P-laine on ALATI seotud QRS-kompleksiga\?/);
  assert.doesNotMatch(questionCard.innerHTML, /Milline on PR-intervall\?/);

  app.runTimers();
  app.click(questionCard.buttons[0]);
  assert.match(questionCard.innerHTML, /Milline on PR-intervall\?/);
});

test("stale option activations after a result do not crash or mutate history", () => {
  const app = setupApp();
  const questionCard = app.elements.get("question-card");
  const breadcrumb = app.elements.get("breadcrumb");
  const resultCard = app.elements.get("result-card");

  app.click(questionCard.buttons[0]);
  app.runTimers();
  app.click(questionCard.buttons[0]);
  app.runTimers();

  const finalOption = questionCard.buttons[0];
  app.click(finalOption);
  app.runTimers();

  const breadcrumbBefore = breadcrumb.innerHTML;
  app.click(finalOption);

  assert.match(resultCard.innerHTML, /Siinus rütm/);
  assert.equal(breadcrumb.innerHTML, breadcrumbBefore);
});
