// Unit tests for store.js settings merge / triggerMode migration. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");

// Minimal chrome.storage stub + JevApi defaults so store.js can load in Node.
globalThis.JevApi = {
  DEFAULT_API_SETTINGS: {
    baseUrl: "https://api.typesafe.ai",
    path: "/v1/systemone",
    authHeader: "Authorization",
    authScheme: "Bearer",
    model: "jev-latest",
    questionKey: "ai_generated",
    responsePath: "answers.{q}.noul",
    instructions: "test"
  }
};

let stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) out[key] = stored[key];
        return out;
      },
      set: async (obj) => {
        stored = { ...stored, ...obj };
      },
      remove: async (key) => {
        delete stored[key];
      }
    }
  }
};

// Re-require after stubs. store.js is a classic script, not a module — eval it.
const fs = require("node:fs");
const path = require("node:path");
const code = fs.readFileSync(path.join(__dirname, "../store.js"), "utf8");
eval(code);

test("default triggerMode is auto", async () => {
  stored = {};
  const settings = await loadSettings();
  assert.equal(settings.triggerMode, "auto");
  assert.equal(settings.dailyAutoLimit, 100);
});

test("migrates autoScanOwn true → triggerMode auto", async () => {
  stored = { settings: { autoScanOwn: true, concurrency: 2 } };
  const settings = await loadSettings();
  assert.equal(settings.triggerMode, "auto");
  assert.equal(settings.concurrency, 2);
});

test("migrates autoScanOwn false → triggerMode manual", async () => {
  stored = { settings: { autoScanOwn: false } };
  const settings = await loadSettings();
  assert.equal(settings.triggerMode, "manual");
});

test("explicit triggerMode wins over autoScanOwn", async () => {
  stored = { settings: { triggerMode: "manual", autoScanOwn: true } };
  const settings = await loadSettings();
  assert.equal(settings.triggerMode, "manual");
});

test("invalid triggerMode falls back to auto", async () => {
  stored = { settings: { triggerMode: "whenever" } };
  const settings = await loadSettings();
  assert.equal(settings.triggerMode, "auto");
});
