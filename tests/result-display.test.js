import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const CHROME_BIN = process.env.CHROME_BIN ?? "/usr/local/bin/google-chrome";

test("completed decision path shows the diagnosis result card", async () => {
  const browser = await launchBrowser();

  try {
    const cdp = await CdpConnection.open(browser.webSocketUrl);
    try {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true
      });

      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Page.navigate", {
        url: pathToFileURL(join(process.cwd(), "index.html")).href
      }, sessionId);
      await waitForReadyState(cdp, sessionId);

      for (const label of ["Jah, normaalne", "Jah", "Normaalne"]) {
        await clickOption(cdp, sessionId, label);
      }

      const { result } = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const resultCard = document.getElementById("result-card");
          const questionCard = document.getElementById("question-card");
          const resultStyle = getComputedStyle(resultCard);
          const questionStyle = getComputedStyle(questionCard);

          return {
            resultDisplay: resultStyle.display,
            resultInlineDisplay: resultCard.style.display,
            resultText: resultCard.textContent,
            questionDisplay: questionStyle.display
          };
        })()`
      }, sessionId);

      assert.equal(result.value.resultInlineDisplay, "block");
      assert.notEqual(result.value.resultDisplay, "none");
      assert.equal(result.value.questionDisplay, "none");
      assert.match(result.value.resultText, /Siinus rütm/);
    } finally {
      cdp.close();
    }
  } finally {
    await browser.close();
  }
});

async function clickOption(cdp, sessionId, label) {
  const escapedLabel = JSON.stringify(label);
  const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `(() => {
      const button = Array.from(document.querySelectorAll(".option-btn"))
        .find((btn) => btn.textContent.trim() === ${escapedLabel});

      if (!button) {
        throw new Error("Option not found: " + ${escapedLabel});
      }

      button.click();
    })()`
  }, sessionId);

  assert.equal(exceptionDetails, undefined, `clicking option "${label}" should not throw`);
}

async function waitForReadyState(cdp, sessionId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { result } = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: "document.readyState"
    }, sessionId);

    if (result.value === "complete") {
      return;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for the page to load");
}

async function launchBrowser() {
  const userDataDir = await mkdtemp(join(tmpdir(), "ecg-result-test-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const webSocketUrl = await waitForDevToolsUrl(chrome);

  return {
    webSocketUrl,
    async close() {
      chrome.kill();
      await Promise.race([
        once(chrome, "exit"),
        delay(2000)
      ]);
      await rm(userDataDir, { recursive: true, force: true });
    }
  };
}

function waitForDevToolsUrl(chrome) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Chrome DevTools URL. Output:\n${output}`));
    }, 10000);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`Chrome exited before DevTools became available, code ${code}. Output:\n${output}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.stdout.off("data", onData);
      chrome.stderr.off("data", onData);
      chrome.off("exit", onExit);
    };

    chrome.stdout.on("data", onData);
    chrome.stderr.on("data", onData);
    chrome.on("exit", onExit);
  });
}

class CdpConnection {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
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

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;

    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.socket.send(JSON.stringify(message));
    return promise;
  }

  close() {
    this.socket.close();
  }
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
