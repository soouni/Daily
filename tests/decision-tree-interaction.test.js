import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;

      const callbacks = this.pending.get(message.id);
      if (!callbacks) return;

      this.pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(message.error.message));
      } else {
        callbacks.resolve(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", resolveOpen, { once: true });
      ws.addEventListener("error", rejectOpen, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome(pageUrl) {
  const userDataDir = await mkdtemp(`${tmpdir()}/ecg-flowchart-test-`);
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    pageUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  const browserWsUrl = await new Promise((resolveLaunch, rejectLaunch) => {
    const timeout = setTimeout(() => {
      rejectLaunch(new Error(`Chrome did not expose DevTools endpoint. stderr:\n${stderr}`));
    }, 10000);

    chrome.stderr.on("data", chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveLaunch(match[1]);
      }
    });

    chrome.once("error", rejectLaunch);
    chrome.once("exit", code => {
      rejectLaunch(new Error(`Chrome exited before tests started with code ${code}. stderr:\n${stderr}`));
    });
  });

  const { port } = new URL(browserWsUrl);
  const pageWsUrl = await waitForPageWebSocket(port, pageUrl);

  return {
    client: await CdpClient.connect(pageWsUrl),
    async close() {
      chrome.kill();
      await once(chrome, "exit");
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

async function waitForPageWebSocket(port, pageUrl) {
  const expectedUrl = pageUrl.replace("file://", "file:///");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find(target =>
      target.type === "page" &&
      target.url.replace("file://", "file:///") === expectedUrl
    );

    if (page?.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }

    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }

  throw new Error("Timed out waiting for page DevTools target");
}

async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (exceptionDetails) {
    throw new Error(exceptionDetails.text);
  }

  return result.value;
}

async function waitForReady(client) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(client, "document.readyState === 'complete'")) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }

  throw new Error("Timed out waiting for document readiness");
}

async function clickOption(client, label) {
  await evaluate(client, `
    (() => {
      const button = [...document.querySelectorAll(".option-btn")]
        .find(btn => btn.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error("Option not found: ${label}");
      button.click();
      return true;
    })()
  `);
}

test("a complete decision path shows the diagnosis result card", async () => {
  const pageUrl = pathToFileURL(resolve("index.html")).href;
  const browser = await launchChrome(pageUrl);

  try {
    const { client } = browser;
    await client.send("Page.enable");
    await waitForReady(client);

    await clickOption(client, "Jah, normaalne");
    await clickOption(client, "Jah");
    await clickOption(client, "Normaalne");

    const resultState = await evaluate(client, `
      (() => {
        const question = document.getElementById("question-card");
        const result = document.getElementById("result-card");
        return {
          questionDisplay: getComputedStyle(question).display,
          resultDisplay: getComputedStyle(result).display,
          resultText: result.querySelector(".result-name")?.textContent.trim(),
          progressWidth: document.getElementById("progress-fill").style.width,
        };
      })()
    `);

    assert.deepEqual(resultState, {
      questionDisplay: "none",
      resultDisplay: "block",
      resultText: "Siinus rütm",
      progressWidth: "100%",
    });
  } finally {
    await browser.close();
  }
});
