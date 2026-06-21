const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

function once(target, eventName) {
  return new Promise((resolve, reject) => {
    target.once(eventName, resolve);
    target.once("error", reject);
  });
}

async function launchChrome(pageUrl) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "ecg-result-test-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    pageUrl
  ]);

  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Chrome did not expose DevTools endpoint:\n${stderr}`));
    }, 10000);

    chrome.stderr.on("data", chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    chrome.once("error", reject);
    chrome.once("exit", code => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited before test startup with code ${code}:\n${stderr}`));
      }
    });
  });

  return { chrome, endpoint, userDataDir };
}

async function connectToPage(endpoint) {
  const { port } = new URL(endpoint);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === "page");
  assert.ok(target, "Expected Chrome to expose a page target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const callbacks = new Map();
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data.toString());
    if (!message.id) return;
    const callback = callbacks.get(message.id);
    if (!callback) return;
    callbacks.delete(message.id);
    if (message.error) {
      callback.reject(new Error(message.error.message));
    } else {
      callback.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => {
        callbacks.set(messageId, { resolve, reject });
      });
    },
    close() {
      ws.close();
    }
  };
}

test("a completed decision path shows the diagnosis card", async t => {
  const pageUrl = `file://${path.resolve(__dirname, "..", "index.html")}`;
  const { chrome, endpoint, userDataDir } = await launchChrome(pageUrl);

  t.after(async () => {
    chrome.kill();
    await once(chrome, "exit").catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  });

  const client = await connectToPage(endpoint);
  t.after(() => client.close());

  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `
      (() => {
        const click = label => {
          const buttons = [...document.querySelectorAll(".option-btn")];
          const button = buttons.find(candidate => candidate.textContent.trim() === label);
          if (!button) throw new Error("Missing option: " + label);
          button.click();
        };

        click("Jah, normaalne");
        click("Jah");
        click("Normaalne");

        const resultCard = document.querySelector("#result-card");
        const questionCard = document.querySelector("#question-card");

        return {
          resultText: resultCard.textContent,
          resultDisplay: getComputedStyle(resultCard).display,
          questionDisplay: getComputedStyle(questionCard).display
        };
      })()
    `
  });

  assert.equal(result.result.type, "object");
  assert.match(result.result.value.resultText, /Siinus rütm/);
  assert.equal(result.result.value.resultDisplay, "block");
  assert.equal(result.result.value.questionDisplay, "none");
});
