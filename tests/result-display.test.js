const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const CHROME_BIN = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
const APP_URL = new URL(`file://${path.resolve(__dirname, "..", "index.html")}`).href;

class DevToolsClient {
  constructor(wsUrl) {
    assert.equal(typeof WebSocket, "function", "Node.js WebSocket support is required");

    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.opened;

    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecg-test-profile-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const browserWsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Chrome DevTools endpoint")), 10000);

    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => {
      const match = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    chrome.once("error", reject);
    chrome.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before opening DevTools endpoint with code ${code}`));
    });
  });

  async function close() {
    chrome.kill();
    fs.rmSync(profileDir, { force: true, recursive: true });
  }

  return { browserWsUrl, close };
}

test("complete ECG decision path displays the rendered result card", async t => {
  const chrome = await launchChrome();
  t.after(chrome.close);

  const browserUrl = new URL(chrome.browserWsUrl);
  const response = await fetch(`http://${browserUrl.host}/json/new?${encodeURIComponent(APP_URL)}`, {
    method: "PUT",
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }

  const target = await response.json();
  const client = new DevToolsClient(target.webSocketDebuggerUrl);
  t.after(() => client.close());

  await client.send("Runtime.enable");
  const evaluation = await client.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(
      async () => {
        const waitForRender = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        for (const label of ["Jah, normaalne", "Jah", "Normaalne"]) {
          const button = Array.from(document.querySelectorAll(".option-btn"))
            .find(candidate => candidate.textContent.trim() === label);
          if (!button) throw new Error("Missing option: " + label);
          button.click();
          await waitForRender();
        }

        const resultCard = document.getElementById("result-card");
        const questionCard = document.getElementById("question-card");
        return {
          resultDisplay: getComputedStyle(resultCard).display,
          questionDisplay: getComputedStyle(questionCard).display,
          resultText: resultCard.textContent,
        };
      }
    )()`,
  });

  assert.equal(evaluation.exceptionDetails, undefined);
  assert.equal(evaluation.result.value.resultDisplay, "block");
  assert.equal(evaluation.result.value.questionDisplay, "none");
  assert.match(evaluation.result.value.resultText, /Siinus/);
});
