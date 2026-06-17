const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForJsonVersion(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Chrome is still starting.
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for Chrome DevTools endpoint");
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;

    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(message));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome() {
  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecg-chrome-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  chrome.stderr.on("data", chunk => {
    stderr += chunk;
  });

  try {
    const version = await waitForJsonVersion(port);
    return { chrome, userDataDir, wsUrl: version.webSocketDebuggerUrl };
  } catch (error) {
    chrome.kill();
    throw new Error(`${error.message}\nChrome stderr:\n${stderr}`);
  }
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }

  return result.result.value;
}

async function waitForExpression(client, sessionId, expression) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await evaluate(client, sessionId, expression)) {
      return;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for expression: ${expression}`);
}

test("completed decision path shows the result card", async () => {
  assert.equal(typeof WebSocket, "function", "Node must provide a WebSocket implementation");

  const { chrome, userDataDir, wsUrl } = await launchChrome();
  const client = new CdpClient(wsUrl);
  const indexUrl = pathToFileURL(path.resolve(__dirname, "..", "index.html")).href;

  try {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });

    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Page.navigate", { url: indexUrl }, sessionId);
    await waitForExpression(client, sessionId, "document.readyState === 'complete'");

    for (const label of ["Jah, normaalne", "Jah", "Normaalne"]) {
      await evaluate(client, sessionId, `
        (() => {
          const button = Array.from(document.querySelectorAll(".option-btn"))
            .find(btn => btn.textContent.trim() === ${JSON.stringify(label)});
          if (!button) {
            throw new Error("Missing option: ${label}");
          }
          button.click();
        })()
      `);
    }

    const state = await evaluate(client, sessionId, `
      (() => {
        const resultCard = document.getElementById("result-card");
        const questionCard = document.getElementById("question-card");
        return {
          resultText: resultCard.textContent,
          resultInlineDisplay: resultCard.style.display,
          resultComputedDisplay: getComputedStyle(resultCard).display,
          questionComputedDisplay: getComputedStyle(questionCard).display,
          progressWidth: document.getElementById("progress-fill").style.width
        };
      })()
    `);

    assert.match(state.resultText, /Siinus/);
    assert.equal(state.resultInlineDisplay, "block");
    assert.notEqual(state.resultComputedDisplay, "none");
    assert.equal(state.questionComputedDisplay, "none");
    assert.equal(state.progressWidth, "100%");
  } finally {
    client.close();
    chrome.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
