// Unit tests for api.js using mocked fetch responses. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../api.js");

// These cases lock the previous one-question wire format. Multi-signal coverage is in signals.test.js.
const cfg = { ...api.DEFAULT_API_SETTINGS, judgeMode: "single" };

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
  assert.equal(body.state, "回复：Great point!");
  assert.equal(body.questions.ai_generated.type, "noul");
  assert.equal(body.questions.ai_generated.instructions, api.DEFAULT_API_SETTINGS.instructions);
  assert.deepEqual(body.questions.ai_generated.criteria, {
    true: api.DEFAULT_API_SETTINGS.criteriaTrue,
    false: api.DEFAULT_API_SETTINGS.criteriaFalse
  });
  assert.equal(body.state.includes("原帖"), false);
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
  assert.equal(JSON.parse(captured.init.body).state, "回复：hello there");
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

const ACCOUNT = "acctTEST000000000000000000000099";
const TOKEN = "cfTESTToken000000000000000099";
const cfCfg = {
  ...api.DEFAULT_API_SETTINGS,
  judgeMode: "single",
  protocol: "cloudflare",
  accountId: ACCOUNT,
  cfModel: "clef-flash"
};

// Shape recorded from a Workers AI Clef probe on 2026-10-16. Values are fixtures, not a live call.
const CF_PROBE = {
  result: {
    model: "clef-flash",
    answers: { q: { type: "noul", noul: 0.9685 } },
    usage: { input_tokens: 199, output_tokens: 0 }
  },
  success: true,
  errors: [],
  messages: []
};

const CF_AUTH_ERROR = {
  result: null,
  success: false,
  errors: [{ code: 10000, message: "Authentication error" }],
  messages: []
};

function assertNoSecrets(message) {
  assert.equal(message.includes(TOKEN), false);
  assert.equal(message.includes(ACCOUNT), false);
  assert.equal(message.includes(encodeURIComponent(ACCOUNT)), false);
}

test("custom question text overrides the default criteria", () => {
  const custom = {
    ...cfg,
    instructions: "完全是另一句问法？",
    criteriaTrue: "像模板",
    criteriaFalse: "像闲聊"
  };
  for (const protocol of ["typesafe", "cloudflare"]) {
    const body = api.buildRequestBody("只是回复正文", { ...custom, protocol });
    assert.equal(body.state, "回复：只是回复正文");
    assert.equal(body.questions.ai_generated.instructions, "完全是另一句问法？");
    assert.deepEqual(body.questions.ai_generated.criteria, { true: "像模板", false: "像闲聊" });
  }
});

test("blank question fields fall back to the default criteria", () => {
  const body = api.buildRequestBody("hi", {
    ...cfg,
    instructions: "  ",
    criteriaTrue: "",
    criteriaFalse: "\n"
  });
  assert.equal(body.questions.ai_generated.instructions, api.DEFAULT_API_SETTINGS.instructions);
  assert.deepEqual(body.questions.ai_generated.criteria, {
    true: api.DEFAULT_API_SETTINGS.criteriaTrue,
    false: api.DEFAULT_API_SETTINGS.criteriaFalse
  });
});

test("the previous English default is not sent", () => {
  const body = api.buildRequestBody("hi", { ...cfg, instructions: api.LEGACY_DEFAULT_INSTRUCTIONS });
  assert.equal(body.questions.ai_generated.instructions, api.DEFAULT_API_SETTINGS.instructions);
  assert.equal(body.questions.ai_generated.instructions.includes("language model"), false);
});

test("defaults stay on TypeSafe Jev and multi-signal judging", () => {
  assert.equal(api.DEFAULT_API_SETTINGS.protocol, "typesafe");
  assert.equal(api.DEFAULT_API_SETTINGS.judgeMode, "multi");
  assert.equal(api.DEFAULT_API_SETTINGS.model, "jev-latest");
  assert.equal(api.DEFAULT_API_SETTINGS.baseUrl, "https://api.typesafe.ai");
  assert.equal(api.DEFAULT_API_SETTINGS.path, "/v1/systemone");
  assert.equal(api.DEFAULT_API_SETTINGS.cfModel, "clef-flash");
  assert.equal(api.DEFAULT_API_SETTINGS.accountId, "");
  assert.equal(api.CF_HOST_PERMISSION, "https://api.cloudflare.com/*");
});

test("cloudflareModel accepts only clef and clef-flash", () => {
  assert.equal(api.cloudflareModel("clef"), "clef");
  assert.equal(api.cloudflareModel("clef-flash"), "clef-flash");
  assert.equal(api.cloudflareModel("  CLEF  "), "clef");
  assert.equal(api.cloudflareModel("CLEF-FLASH"), "clef-flash");
  assert.equal(api.cloudflareModel("jev-latest"), "clef-flash");
  assert.equal(api.cloudflareModel("clef-omni"), "clef-flash");
  assert.equal(api.cloudflareModel(""), "clef-flash");
  assert.equal(api.cloudflareModel(undefined), "clef-flash");
});

test("buildCloudflareRunUrl uses the official path and encodes the account id", () => {
  assert.equal(
    api.buildCloudflareRunUrl(`  ${ACCOUNT}  `, "CLEF"),
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`
  );
  assert.equal(
    api.buildCloudflareRunUrl("a/b c", "not-a-model"),
    "https://api.cloudflare.com/client/v4/accounts/a%2Fbc/ai/run/@cf/cloudflare/clef-flash"
  );
  assert.equal(
    api.buildCloudflareRunUrl("a/b", "clef-flash"),
    "https://api.cloudflare.com/client/v4/accounts/a%2Fb/ai/run/@cf/cloudflare/clef-flash"
  );
  assert.equal(api.normalizeAccountId(" test \n account "), "testaccount");
  assert.throws(() => api.buildCloudflareRunUrl(" \n ", "clef"), (error) => {
    assert.equal(error.message, "Cloudflare Account ID is required");
    assertNoSecrets(error.message);
    return true;
  });
});

test("Jev URL and body ignore Cloudflare fields", () => {
  const legacy = { ...api.DEFAULT_API_SETTINGS, accountId: ACCOUNT, cfModel: "clef" };
  delete legacy.protocol;
  assert.equal(api.requestUrl(legacy), "https://api.typesafe.ai/v1/systemone");
  assert.equal(api.requestUrl(cfg).includes(ACCOUNT), false);
  const body = api.buildRequestBody("Great point!", { ...cfg, accountId: ACCOUNT, cfModel: "clef" });
  assert.equal(body.model, "jev-latest");
  assert.equal(JSON.stringify(body).includes(ACCOUNT), false);
  assert.equal(JSON.stringify(body).includes("clef"), false);
});

test("Cloudflare request uses clef model, Bearer auth, and the run URL", () => {
  assert.equal(
    api.requestUrl(cfCfg),
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`
  );
  const clef = api.requestUrl({ ...cfCfg, cfModel: "clef", model: "jev-latest" });
  assert.equal(clef.endsWith("/@cf/cloudflare/clef"), true);
  const body = api.buildRequestBody("Great point!", { ...cfCfg, model: "jev-latest", cfModel: "clef" });
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "clef");
  assert.equal(body.state, "回复：Great point!");
  assert.equal(body.questions.ai_generated.type, "noul");
  assert.deepEqual(body.questions.ai_generated.criteria, {
    true: api.DEFAULT_API_SETTINGS.criteriaTrue,
    false: api.DEFAULT_API_SETTINGS.criteriaFalse
  });
  assert.deepEqual(api.buildHeaders(TOKEN, { ...cfCfg, authHeader: "X-Api-Key", authScheme: "" }), {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`
  });
  assert.equal(api.requestUrl({ ...cfCfg, cfModel: "jev-latest" }).endsWith("/clef-flash"), true);
});

test("parses result.answers and prefers it over a top-level answers object", () => {
  const qCfg = { ...cfCfg, questionKey: "q" };
  assert.equal(api.parseProbability(CF_PROBE, qCfg), 97);
  assert.equal(api.parseProbability({ answers: { q: { noul: 0.5 } } }, qCfg), 50);
  assert.equal(api.parseProbability({
    result: { answers: { q: { noul: 0.9 } } },
    answers: { q: { noul: 0.1 } }
  }, qCfg), 90);
  assert.equal(api.parseProbability({
    result: { answers: { ai_generated: { noul: 0.1 } } },
    answers: { ai_generated: { noul: 0.87 } }
  }, cfg), 87);
});

test("detectText calls the Cloudflare run URL and reads result.model", async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, init };
    return mockResponse(200, {
      result: {
        model: "clef-flash",
        answers: { ai_generated: { type: "noul", noul: 0.9685 } },
        usage: { input_tokens: 199, output_tokens: 0 }
      },
      success: true,
      errors: [],
      messages: []
    });
  };
  const result = await api.detectText("hello there", TOKEN, { ...cfCfg, model: "jev-latest" }, { fetch });
  assert.equal(result.probability, 97);
  assert.equal(result.model, "clef-flash");
  assert.equal(captured.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`);
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "clef-flash");
  assert.equal(body.state, "回复：hello there");
  assert.equal(body.model === "jev-latest", false);
});

test("Cloudflare HTTP 200 success:false is an error and hides secrets", async () => {
  let calls = 0;
  const leaked = {
    result: { answers: { ai_generated: { noul: 0.99 } } },
    success: false,
    errors: [{ code: 10000, message: `Authentication error Bearer ${TOKEN} ${ACCOUNT}` }],
    messages: []
  };
  const fetch = async () => (calls++, mockResponse(200, leaked));
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch, sleep: async () => {} }), (error) => {
    assert.equal(error.status, 200);
    assert.equal(error.message, "Cloudflare 200: Authentication error Bearer [redacted] [redacted] (10000)");
    assertNoSecrets(error.message);
    return true;
  });
  assert.equal(calls, 1);
});

test("Cloudflare 401 reports status, message, and code only", async () => {
  let calls = 0;
  const fetch = async () => (calls++, mockResponse(401, {
    ...CF_AUTH_ERROR,
    debug: `token=${TOKEN} account=${ACCOUNT} https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`
  }));
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch, maxRetries: 3 }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, "Cloudflare 401: Authentication error (10000)");
    assertNoSecrets(error.message);
    return true;
  });
  assert.equal(calls, 1);
});

test("Cloudflare 400 validation error keeps the server message", async () => {
  const fetch = async () => mockResponse(400, {
    errors: [{ message: "AiError: Bad input: required properties at '/' are 'model,state,questions'", code: 5006 }],
    success: false
  });
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(
      error.message,
      "Cloudflare 400: AiError: Bad input: required properties at '/' are 'model,state,questions' (5006)"
    );
    assertNoSecrets(error.message);
    return true;
  });
});

test("Cloudflare error without errors[0] does not dump the body", async () => {
  const fetch = async () => mockResponse(401, { success: false, errors: [], leaked: TOKEN, accountId: ACCOUNT });
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch }), (error) => {
    assert.equal(error.message, "Cloudflare 401: Request failed");
    assertNoSecrets(error.message);
    return true;
  });
});

test("Cloudflare network errors redact the token and account id", async () => {
  const fetch = async (url) => {
    throw new Error(`connect failed ${url} Authorization: Bearer ${TOKEN}`);
  };
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch }), (error) => {
    assert.match(error.message, /^Network error:/);
    assert.match(error.message, /\/accounts\/\[redacted\]\//);
    assertNoSecrets(error.message);
    return true;
  });
});

test("missing Cloudflare account id fails before fetch", async () => {
  let calls = 0;
  const fetch = async () => (calls++, mockResponse(200, CF_PROBE));
  await assert.rejects(
    api.detectText("x", TOKEN, { ...cfCfg, accountId: " \n " }, { fetch }),
    (error) => error.message === "Cloudflare Account ID is required" && !error.message.includes(TOKEN)
  );
  assert.equal(calls, 0);
});

test("Cloudflare retries 429 without a rate-limit header, then 5xx", async () => {
  const waits = [];
  let calls = 0;
  const fetch = async () => (++calls === 1 ? mockResponse(429, { success: false, errors: [{ message: "slow" }] }) : mockResponse(200, {
    result: { model: "clef", answers: { ai_generated: { noul: 0.25 } } },
    success: true
  }));
  const result = await api.detectText("x", TOKEN, { ...cfCfg, cfModel: "clef" }, {
    fetch,
    sleep: async (ms) => waits.push(ms)
  });
  assert.equal(result.probability, 25);
  assert.equal(result.model, "clef");
  assert.deepEqual(waits, [500]);

  calls = 0;
  waits.length = 0;
  const fetch500 = async () => (++calls < 3 ? mockResponse(502, { success: false, errors: [{ code: 5006, message: `upstream ${ACCOUNT} ${TOKEN}` }] }) : mockResponse(200, {
    result: { model: "clef-flash", answers: { ai_generated: { noul: 0.5 } } },
    success: true
  }));
  const recovered = await api.detectText("x", TOKEN, cfCfg, { fetch: fetch500, sleep: async (ms) => waits.push(ms), maxRetries: 2 });
  assert.equal(recovered.probability, 50);
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(calls, 3);
});

test("Cloudflare 5xx after retries is redacted and Jev 502 is not retried", async () => {
  let calls = 0;
  const fetch = async () => (calls++, mockResponse(502, {
    success: false,
    errors: [{ code: 5006, message: `upstream ${ACCOUNT} bearer ${TOKEN}` }]
  }));
  await assert.rejects(api.detectText("x", TOKEN, cfCfg, { fetch, sleep: async () => {}, maxRetries: 1 }), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /^Cloudflare 502: upstream \[redacted\] Bearer \[redacted\] \(5006\)$/);
    assertNoSecrets(error.message);
    return true;
  });
  assert.equal(calls, 2);

  calls = 0;
  const jevFetch = async () => (calls++, mockResponse(502, "down"));
  await assert.rejects(api.detectText("x", "k", cfg, { fetch: jevFetch, sleep: async () => {}, maxRetries: 3 }), (error) => error.status === 502);
  assert.equal(calls, 1);
});
