const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const CHROME_BIN = process.env.CHROME_BIN || "/usr/local/bin/google-chrome";

async function rmDirEventually(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url !== "/" && req.url !== "/index.html") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(INDEX_PATH).pipe(res);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
    server.on("error", reject);
  });
}

async function waitForJson(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw lastError;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

async function startChrome() {
  const port = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecg-chrome-"));
  const chrome = spawn(CHROME_BIN, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: "ignore" });

  await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const pageTarget = targets.find(target => target.type === "page");
  assert.ok(pageTarget, "Chrome did not expose a page target");
  const wsUrl = pageTarget.webSocketDebuggerUrl;

  return {
    port,
    wsUrl,
    close: async () => {
      if (!chrome.killed) {
        chrome.kill();
      }
      if (chrome.exitCode === null) {
        await new Promise(resolve => chrome.once("exit", resolve));
      }
      await rmDirEventually(userDataDir);
    }
  };
}

function connectDevTools(wsUrl) {
  const { hostname, port, pathname } = new URL(wsUrl);

  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      const key = Buffer.from("ecg-result-test").toString("base64");
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${hostname}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });

    let handshake = "";
    let nextId = 1;
    const callbacks = new Map();

    socket.on("data", chunk => {
      if (!handshake) {
        const text = chunk.toString("utf8");
        const end = text.indexOf("\r\n\r\n");
        if (end === -1) {
          handshake += text;
          return;
        }
        handshake = text.slice(0, end);
        const remaining = chunk.subarray(Buffer.byteLength(text.slice(0, end + 4)));
        if (remaining.length) {
          handleFrames(remaining);
        }
        resolve({ send, close: () => socket.end() });
        return;
      }

      handleFrames(chunk);
    });
    socket.on("error", reject);

    function send(method, params = {}) {
      const id = nextId++;
      const message = JSON.stringify({ id, method, params });
      socket.write(encodeFrame(message));

      return new Promise((resolveSend, rejectSend) => {
        callbacks.set(id, { resolve: resolveSend, reject: rejectSend });
      });
    }

    function handleFrames(buffer) {
      for (const payload of decodeFrames(buffer)) {
        const message = JSON.parse(payload);
        if (!message.id) {
          continue;
        }
        const callback = callbacks.get(message.id);
        if (!callback) {
          continue;
        }
        callbacks.delete(message.id);
        if (message.error) {
          callback.reject(new Error(message.error.message));
        } else {
          callback.resolve(message.result);
        }
      }
    }
  });
}

function encodeFrame(message) {
  const payload = Buffer.from(message);
  const headerLength = payload.length < 126 ? 6 : 8;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x81;

  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    frame.writeUInt32BE(0, 2);
    payload.copy(frame, 6);
  } else {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    frame.writeUInt32BE(0, 4);
    payload.copy(frame, 8);
  }

  return frame;
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      throw new Error("Large WebSocket frames are not supported by this test");
    }

    const end = offset + headerLength + length;
    if (end > buffer.length) {
      break;
    }

    messages.push(buffer.subarray(offset + headerLength, end).toString("utf8"));
    offset = end;
  }

  return messages;
}

test("a completed decision path shows the diagnosis result", async () => {
  const { server, url } = await startStaticServer();
  const chrome = await startChrome();
  const client = await connectDevTools(chrome.wsUrl);

  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url });

    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const clickOption = (label) => {
          const button = [...document.querySelectorAll(".option-btn")]
            .find(btn => btn.textContent.trim() === label);
          if (!button) throw new Error("Missing option: " + label);
          button.click();
        };

        clickOption("Jah, normaalne");
        clickOption("Jah");
        clickOption("Normaalne");

        const resultCard = document.getElementById("result-card");
        return {
          display: getComputedStyle(resultCard).display,
          text: resultCard.textContent,
          questionDisplay: getComputedStyle(document.getElementById("question-card")).display
        };
      })()`
    });

    assert.equal(result.result.value.display, "block");
    assert.match(result.result.value.text, /Siinus rütm/);
    assert.equal(result.result.value.questionDisplay, "none");
  } finally {
    client.close();
    await chrome.close();
    await new Promise(resolve => server.close(resolve));
  }
});
