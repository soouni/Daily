const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT_DIR, "index.html");
const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data.toString());
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
        return;
      }

      resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    this.socket.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.close();
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      res.writeHead(404).end("Not found");
      return;
    }

    const html = await fs.readFile(INDEX_PATH, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

async function waitForDevToolsEndpoint(chrome) {
  let stderr = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Chrome did not expose DevTools endpoint. stderr:\n${stderr}`));
    }, 10000);

    chrome.stderr.on("data", chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) {
        return;
      }

      clearTimeout(timeout);
      resolve(match[1]);
    });

    chrome.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    chrome.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready with code ${code}. stderr:\n${stderr}`));
    });
  });
}

async function connectWebSocket(url) {
  const socket = new WebSocket(url);

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return new CdpClient(socket);
}

async function waitForReady(cdp, sessionId) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true
    }, sessionId);

    if (result.result.value === "complete") {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error("Page did not finish loading");
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    child.once("exit", resolve);
  });
}

test("a completed decision path shows the diagnosis card", async () => {
  const server = createServer();
  const port = await listen(server);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ecg-rhythm-test-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let cdp;

  try {
    const endpoint = await waitForDevToolsEndpoint(chrome);
    cdp = await connectWebSocket(endpoint);

    const { targetId } = await cdp.send("Target.createTarget", {
      url: `http://127.0.0.1:${port}/index.html`
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });

    await waitForReady(cdp, sessionId);

    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const clickOption = label => {
          const button = Array.from(document.querySelectorAll(".option-btn"))
            .find(candidate => candidate.textContent.trim() === label);
          if (!button) {
            throw new Error("Missing option: " + label);
          }
          button.click();
        };

        clickOption("Jah, normaalne");
        clickOption("Jah");
        clickOption("Normaalne");

        const resultCard = document.getElementById("result-card");
        return {
          computedDisplay: getComputedStyle(resultCard).display,
          inlineDisplay: resultCard.style.display,
          text: resultCard.innerText,
          questionDisplay: getComputedStyle(document.getElementById("question-card")).display
        };
      })()`,
      returnByValue: true
    }, sessionId);

    assert.equal(result.result.value.computedDisplay, "block");
    assert.equal(result.result.value.inlineDisplay, "block");
    assert.equal(result.result.value.questionDisplay, "none");
    assert.match(result.result.value.text, /Siinus rütm/);
  } finally {
    if (cdp) {
      cdp.close();
    }
    chrome.kill();
    await waitForProcessExit(chrome);
    await fs.rm(userDataDir, { recursive: true, force: true });
    await closeServer(server);
  }
});
