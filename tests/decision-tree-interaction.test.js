const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

test("completed decision path shows the rhythm result", { timeout: 15000 }, async (t) => {
  const chrome = await launchChrome(t);
  const client = await connectToPage(chrome.port);

  t.after(() => {
    client.close();
  });

  await client.send("Page.enable");

  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", {
    url: pathToFileURL(path.join(__dirname, "..", "index.html")).href
  });
  await loaded;

  await clickOption(client, "Jah, normaalne");
  await clickOption(client, "Jah");
  await clickOption(client, "Normaalne");

  const resultState = await evaluate(client, `(() => {
    const resultCard = document.getElementById("result-card");
    const questionCard = document.getElementById("question-card");

    return {
      resultDisplay: getComputedStyle(resultCard).display,
      questionDisplay: getComputedStyle(questionCard).display,
      text: resultCard.textContent.trim()
    };
  })()`);

  assert.equal(resultState.resultDisplay, "block");
  assert.equal(resultState.questionDisplay, "none");
  assert.match(resultState.text, /Siinus rütm/);
});

async function launchChrome(t) {
  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecg-tree-chrome-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  chrome.stderr.on("data", chunk => {
    stderr += chunk.toString();
  });

  t.after(() => {
    chrome.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  await waitForDevTools(port, chrome, () => stderr);
  return { port };
}

async function connectToPage(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find(item => item.type === "page");

  assert.ok(target?.webSocketDebuggerUrl, "Chrome did not expose a page target");
  const client = new DevToolsClient(target.webSocketDebuggerUrl);
  await client.ready;
  return client;
}

async function clickOption(client, label) {
  const clickResult = await evaluate(client, `(label => {
    const buttons = Array.from(document.querySelectorAll(".option-btn"));
    const button = buttons.find(btn => btn.textContent.trim() === label);

    if (!button) {
      return {
        clicked: false,
        labels: buttons.map(btn => btn.textContent.trim())
      };
    }

    button.click();
    return { clicked: true };
  })(${JSON.stringify(label)})`);

  assert.equal(
    clickResult.clicked,
    true,
    `Expected to find option "${label}" among ${JSON.stringify(clickResult.labels)}`
  );
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text);
  }

  return response.result.value;
}

class DevToolsClient {
  constructor(webSocketDebuggerUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = event => this.handleMessage(event.data);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  once(method) {
    return new Promise(resolve => {
      const handler = params => {
        const handlers = this.eventHandlers.get(method) || [];
        this.eventHandlers.set(method, handlers.filter(item => item !== handler));
        resolve(params);
      };

      const handlers = this.eventHandlers.get(method) || [];
      handlers.push(handler);
      this.eventHandlers.set(method, handlers);
    });
  }

  handleMessage(data) {
    const message = JSON.parse(data);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const handlers = this.eventHandlers.get(message.method) || [];
    for (const handler of handlers) {
      handler(message.params);
    }
  }

  close() {
    this.socket.close();
  }
}

async function waitForDevTools(port, chrome, getStderr) {
  const url = `http://127.0.0.1:${port}/json/version`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited early with code ${chrome.exitCode}: ${getStderr()}`);
    }

    try {
      await fetchJson(url);
      return;
    } catch {
      await delay(100);
    }
  }

  throw new Error(`Timed out waiting for Chrome DevTools: ${getStderr()}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
