const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }

  const candidates = [
    "/usr/local/bin/google-chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];

  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) {
    throw new Error("Chrome executable not found. Set CHROME_BIN to run browser tests.");
  }

  return chrome;
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecg-flowchart-chrome-"));
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });

  const browserWsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for Chrome DevTools endpoint.\n${stderr}`));
    }, 10000);

    chrome.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools was ready with code ${code}.\n${stderr}`));
    });

    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });

  return {
    browserWsUrl,
    async close() {
      chrome.kill();
      await new Promise(resolve => chrome.once("exit", resolve));
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

async function openPage(browserWsUrl) {
  const { host } = new URL(browserWsUrl);
  const response = await fetch(`http://${host}/json/new?about:blank`, { method: "PUT" });
  assert.equal(response.ok, true, `Unable to create Chrome page: ${response.status}`);
  const target = await response.json();
  return connectCdp(target.webSocketDebuggerUrl);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
    } else {
      resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    }
  };
}

async function waitForPageReady(page) {
  for (let i = 0; i < 50; i += 1) {
    const result = await evaluate(page, "document.readyState");
    if (result === "complete") {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for page load");
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text);
  }

  return response.result.value;
}

async function clickOption(page, label) {
  await evaluate(page, `
    (() => {
      const button = Array.from(document.querySelectorAll(".option-btn"))
        .find(candidate => candidate.textContent.trim() === ${JSON.stringify(label)});
      if (!button) {
        throw new Error("Could not find option: " + ${JSON.stringify(label)});
      }
      button.click();
      return true;
    })()
  `);
}

test("complete decision path displays the diagnosis result", async () => {
  const chrome = await launchChrome();
  const page = await openPage(chrome.browserWsUrl);

  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Page.navigate", {
      url: pathToFileURL(path.join(__dirname, "..", "index.html")).href
    });
    await waitForPageReady(page);

    await clickOption(page, "Jah, normaalne");
    await clickOption(page, "Jah");
    await clickOption(page, "Normaalne");

    const result = await evaluate(page, `
      (() => {
        const questionCard = document.getElementById("question-card");
        const resultCard = document.getElementById("result-card");
        return {
          questionDisplay: getComputedStyle(questionCard).display,
          resultDisplay: getComputedStyle(resultCard).display,
          resultInlineDisplay: resultCard.style.display,
          resultText: resultCard.textContent,
          progressWidth: document.getElementById("progress-fill").style.width
        };
      })()
    `);

    assert.equal(result.questionDisplay, "none");
    assert.equal(result.resultDisplay, "block");
    assert.equal(result.resultInlineDisplay, "block");
    assert.match(result.resultText, /Siinus rütm/);
    assert.equal(result.progressWidth, "100%");
  } finally {
    page.close();
    await chrome.close();
  }
});
