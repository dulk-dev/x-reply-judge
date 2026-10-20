// Unit tests for store.js settings merge / triggerMode migration. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");

// Real api.js defaults, so protocol migration matches production.
globalThis.JevApi = require("../api.js");

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

test("empty storage stays on TypeSafe Jev and multi-signal mode", async () => {
  stored = {};
  const settings = await loadSettings();
  assert.equal(settings.protocol, "typesafe");
  assert.equal(settings.judgeMode, "multi");
  assert.equal(settings.model, "jev-latest");
  assert.equal(settings.baseUrl, "https://api.typesafe.ai");
  assert.equal(settings.path, "/v1/systemone");
  assert.equal(settings.responsePath, "answers.{q}.noul");
  assert.equal(settings.cfModel, "clef-flash");
  assert.equal(settings.accountId, "");
});

test("old settings without protocol keep Jev and gain Clef defaults", async () => {
  stored = {
    settings: {
      model: "jev-1.13.0",
      baseUrl: "https://api.typesafe.ai",
      concurrency: 2,
      instructions: "custom question"
    }
  };
  const settings = await loadSettings();
  assert.equal(settings.protocol, "typesafe");
  assert.equal(settings.model, "jev-1.13.0");
  assert.equal(settings.baseUrl, "https://api.typesafe.ai");
  assert.equal(settings.instructions, "custom question");
  assert.equal(settings.concurrency, 2);
  assert.equal(settings.cfModel, "clef-flash");
  assert.equal(settings.accountId, "");
});

test("unknown protocol falls back to typesafe without touching the Jev model", async () => {
  stored = { settings: { protocol: "openai", model: "jev-latest" } };
  const settings = await loadSettings();
  assert.equal(settings.protocol, "typesafe");
  assert.equal(settings.model, "jev-latest");
});

test("saved copy of the old English default upgrades to the criteria question", async () => {
  stored = {
    settings: {
      instructions: JevApi.LEGACY_DEFAULT_INSTRUCTIONS,
      model: "jev-1.13.0"
    }
  };
  const settings = await loadSettings();
  assert.equal(settings.instructions, JevApi.DEFAULT_API_SETTINGS.instructions);
  assert.equal(settings.criteriaTrue, JevApi.DEFAULT_API_SETTINGS.criteriaTrue);
  assert.equal(settings.criteriaFalse, JevApi.DEFAULT_API_SETTINGS.criteriaFalse);
  assert.equal(settings.model, "jev-1.13.0");
  assert.equal(settings.instructions.includes("language model"), false);
});

test("a custom question is kept and blank criteria use the defaults", async () => {
  stored = {
    settings: {
      instructions: "  我自己的问法  ",
      criteriaTrue: " ",
      criteriaFalse: "自己的否"
    }
  };
  const settings = await loadSettings();
  assert.equal(settings.instructions, "我自己的问法");
  assert.equal(settings.criteriaTrue, JevApi.DEFAULT_API_SETTINGS.criteriaTrue);
  assert.equal(settings.criteriaFalse, "自己的否");
});

test("saved 0.3.1 criteria upgrade, and a custom side stays", async () => {
  stored = {
    settings: {
      criteriaTrue: JevApi.LEGACY_CRITERIA_TRUE,
      criteriaFalse: "自己的否"
    }
  };
  const settings = await loadSettings();
  assert.equal(settings.criteriaTrue, JevApi.DEFAULT_API_SETTINGS.criteriaTrue);
  assert.equal(settings.criteriaFalse, "自己的否");
  assert.equal(settings.criteriaTrue.includes("先定性或肯定"), true);
});

test("saveScores stores a v3 key and drops an entry without one", async () => {
  stored = {};
  await saveScores([
    { key: "v3:m:p:1", probability: 40, tooltip: "r1_generic 万能回复 +35" },
    { probability: 99 }
  ]);
  assert.deepEqual(Object.keys(stored.scoreCache), ["v3:m:p:1"]);
  assert.equal(stored.scoreCache["v3:m:p:1"].probability, 40);
  assert.equal(stored.scoreCache["v3:m:p:1"].tooltip, "r1_generic 万能回复 +35");
});

test("explicit single mode is kept and anything else becomes multi", async () => {
  stored = { settings: { judgeMode: " single " } };
  assert.equal((await loadSettings()).judgeMode, "single");
  stored = { settings: { judgeMode: "legacy" } };
  assert.equal((await loadSettings()).judgeMode, "multi");
});

test("explicit cloudflare settings are kept and the model is normalized", async () => {
  stored = {
    settings: {
      protocol: " Cloudflare ",
      cfModel: " CLEF ",
      accountId: " test-account \n id ",
      model: "jev-latest"
    }
  };
  const settings = await loadSettings();
  assert.equal(settings.protocol, "cloudflare");
  assert.equal(settings.cfModel, "clef");
  assert.equal(settings.accountId, "test-accountid");
  assert.equal(settings.model, "jev-latest");
});
