// Unit tests for api.js using mocked fetch responses. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../api.js");

const cfg = { ...api.DEFAULT_API_SETTINGS };

function mockResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// Shape copied from the documented noul example in https://docs.typesafe.ai/api/system-one.md
const DOC_RESPONSE = {
  model: "jev-latest",
  answers: { ai_generated: { type: "noul", noul: 0.87 } },
  usage: { input_tokens: 120, output_tokens: 12 }
};

test("parses documented noul response into a percentage", () => {
  assert.equal(api.parseProbability(DOC_RESPONSE, cfg), 87);
});

test("rounds and handles edges", () => {
  const mk = (v) => ({ answers: { ai_generated: { noul: v } } });
  assert.equal(api.parseProbability(mk(0), cfg), 0);
  assert.equal(api.parseProbability(mk(1), cfg), 100);
  assert.equal(api.parseProbability(mk(0.305), cfg), 31);
  assert.equal(api.parseProbability(mk("0.5"), cfg), 50);
});

test("custom response path, percent-scale value", () => {
  const custom = { ...cfg, responsePath: "probabilities.ai" };
  assert.equal(api.parseProbability({ probabilities: { ai: 0.12 } }, custom), 12);
  assert.equal(api.parseProbability({ probabilities: { ai: 64 } }, custom), 64);
});

test("rejects missing, non-numeric and out-of-range values", () => {
  assert.throws(() => api.parseProbability({ answers: {} }, cfg), /no numeric value/);
  assert.throws(() => api.parseProbability({ answers: { ai_generated: { noul: null } } }, cfg), /no numeric/);
  assert.throws(() => api.parseProbability({ answers: { ai_generated: { noul: -0.1 } } }, cfg), /out of range/);
  assert.throws(() => api.parseProbability({ answers: { ai_generated: { noul: 150 } } }, cfg), /out of range/);
});

test("request contains ONLY the reply text as state", () => {
  const body = api.buildRequestBody("Great point!", cfg);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.state, "Great point!");
  assert.equal(body.questions.ai_generated.type, "noul");
  assert.equal(api.buildUrl(cfg), "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(api.buildHeaders("k", cfg), { "Content-Type": "application/json", Authorization: "Bearer k" });
  assert.deepEqual(api.buildHeaders("k", { ...cfg, authHeader: "X-Api-Key", authScheme: "" }), {
    "Content-Type": "application/json", "X-Api-Key": "k"
  });
});

test("detectText end-to-end with mocked fetch", async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, init };
    return mockResponse(200, DOC_RESPONSE);
  };
  const result = await api.detectText("hello there", "test-key", cfg, { fetch });
  assert.equal(result.probability, 87);
  assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(captured.init.body).state, "hello there");
});

test("retries 429 honoring retry-after, then succeeds", async () => {
  const waits = [];
  let calls = 0;
  const fetch = async () => (++calls < 3 ? mockResponse(429, "slow down", { "retry-after": "2" }) : mockResponse(200, DOC_RESPONSE));
  const result = await api.detectText("x", "k", cfg, { fetch, sleep: async (ms) => waits.push(ms) });
  assert.equal(result.probability, 87);
  assert.deepEqual(waits, [2000, 2000]);
});

test("401 is not retried and surfaces status", async () => {
  let calls = 0;
  const fetch = async () => (calls++, mockResponse(401, { detail: "bad key" }));
  await assert.rejects(api.detectText("x", "k", cfg, { fetch, sleep: async () => {} }), (e) => e.status === 401 && /invalid API key/.test(e.message));
  assert.equal(calls, 1);
});

test("mapWithConcurrency respects the limit and isolates failures", async () => {
  let inFlight = 0, peak = 0;
  const out = await api.mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n === 3) throw new Error("boom");
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.equal(out[2].ok, false);
  assert.equal(out[5].value, 60);
});

test("originPattern", () => {
  assert.equal(api.originPattern("https://api.typesafe.ai/v1"), "https://api.typesafe.ai/*");
  assert.equal(api.originPattern("ftp://x"), null);
  assert.equal(api.originPattern("nope"), null);
});
