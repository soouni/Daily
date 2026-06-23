const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const INDEX_URL = `file://${path.join(ROOT, "index.html")}`;
const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

function requestJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

async function waitForChrome(port) {
  const deadline = Date.now() + 10000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await requestJson(`http://127.0.0.1:${port}/json/version`);
    } catch (err) {
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw lastError || new Error("Timed out waiting for Chrome");
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function createDevToolsClient(ws) {
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;

    const callbacks = pending.get(message.id);
    if (!callbacks) return;

    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(message.error.message));
    } else {
      callbacks.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      ws.close();
    }
  };
}

async function withPage(fn) {
  assert.ok(existsSync(CHROME_BIN), `Chrome not found at ${CHROME_BIN}`);

  const port = 9222 + Math.floor(Math.random() * 1000);
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    "about:blank"
  ], { stdio: "ignore" });

  try {
    await waitForChrome(port);

    const target = await requestJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(INDEX_URL)}`);
    const ws = await connectWebSocket(target.webSocketDebuggerUrl);
    const client = createDevToolsClient(ws);

    try {
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      await client.send("Page.bringToFront");
      await client.send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' || new Promise(resolve => window.addEventListener('load', () => resolve(true), { once: true }))",
        awaitPromise: true
      });

      return await fn(client);
    } finally {
      client.close();
    }
  } finally {
    chrome.kill();
    await once(chrome, "exit").catch(() => {});
  }
}

test("completed decision path displays the diagnosis result card", async () => {
  await withPage(async client => {
    const { result } = await client.send("Runtime.evaluate", {
      expression: `
        (async () => {
          const clickByText = text => {
            const button = [...document.querySelectorAll(".option-btn")]
              .find(btn => btn.textContent.trim() === text);
            if (!button) throw new Error("Missing option: " + text);
            button.click();
          };

          clickByText("Jah, normaalne");
          clickByText("Jah");
          clickByText("Normaalne");

          const card = document.getElementById("result-card");
          const styles = getComputedStyle(card);
          return {
            display: styles.display,
            name: card.querySelector(".result-name")?.textContent.trim(),
            visible: styles.display !== "none" && card.offsetParent !== null
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    assert.deepEqual(result.value, {
      display: "block",
      name: "Siinus rütm",
      visible: true
    });
  });
});
