// Multi-signal scoring, parent-post state, cache keys, and the Options read-only list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../api.js");

const WEIGHTS = {
  r1: 35, r2: 30, r9: 30, r3: 15, r4: 15, r5: 15, r6: 15, r7: 15, r8: 7,
  h1: -30, h2: -15, h3: -25, h4: -20
};

function answers(values) {
  const out = {};
  for (const q of api.MULTI_QUESTIONS) out[q.key] = { type: "noul", noul: values[q.key] ?? 0 };
  return out;
}

test("the 13 questions and their weights are the scoring constant", () => {
  assert.deepEqual(api.MULTI_QUESTIONS.map((q) => q.key), Object.keys(WEIGHTS));
  for (const q of api.MULTI_QUESTIONS) {
    assert.equal(q.weight, WEIGHTS[q.key]);
    assert.equal(q.kind, q.weight > 0 ? "ai" : "human");
    assert.equal(q.instructions.trim().length > 0, true);
    assert.equal(q.criteria.true.trim().length > 0, true);
    assert.equal(q.criteria.false.trim().length > 0, true);
  }
  const ai = api.MULTI_QUESTIONS.filter((q) => q.kind === "ai").reduce((sum, q) => sum + q.weight, 0);
  const human = api.MULTI_QUESTIONS.filter((q) => q.kind === "human").reduce((sum, q) => sum + q.weight, 0);
  assert.equal(ai, 177);
  assert.equal(human, -90);
});

test("parent context formats state, and a blank parent stays reply-only", () => {
  assert.equal(api.formatJudgeState("回复正文", "原帖正文"), "原帖：原帖正文\n\n回复：回复正文");
  assert.equal(api.formatJudgeState("只是回复", "  \n"), "只是回复");
  const body = api.buildRequestBody("回复正文", api.DEFAULT_API_SETTINGS, " 原帖正文 ");
  assert.equal(body.state, "原帖：原帖正文\n\n回复：回复正文");
  assert.equal(JSON.stringify(body).includes("@"), false);
  assert.deepEqual(Object.keys(body.questions), Object.keys(WEIGHTS));
  assert.equal(body.questions.r1.type, "noul");
  assert.equal(body.questions.r1.instructions, api.MULTI_QUESTIONS[0].instructions);
});

test("single mode sends the broadened question and upgrades 0.3.1 criteria", () => {
  const single = { ...api.DEFAULT_API_SETTINGS, judgeMode: "single" };
  const body = api.buildRequestBody("回复", single, "原帖");
  assert.equal(body.state, "原帖：原帖\n\n回复：回复");
  assert.deepEqual(Object.keys(body.questions), ["ai_generated"]);
  assert.equal(body.questions.ai_generated.criteria.true, api.DEFAULT_API_SETTINGS.criteriaTrue);
  assert.equal(body.questions.ai_generated.criteria.true.includes("先定性或肯定"), true);
  const legacy = api.buildRequestBody("回复", {
    ...single,
    criteriaTrue: api.LEGACY_CRITERIA_TRUE,
    criteriaFalse: api.LEGACY_CRITERIA_FALSE
  });
  assert.deepEqual(legacy.questions.ai_generated.criteria, {
    true: api.DEFAULT_API_SETTINGS.criteriaTrue,
    false: api.DEFAULT_API_SETTINGS.criteriaFalse
  });
});

test("cache keys are v3:<m|s>:<p|r>:<id>", () => {
  assert.equal(api.cacheKey("multi", "原帖", "99"), "v3:m:p:99");
  assert.equal(api.cacheKey("single", "", "99"), "v3:s:r:99");
  assert.equal(api.cacheKey("nope", "  ", "99"), "v3:m:r:99");
});

test("score clamps the weighted sum and bands it", () => {
  const allYes = api.scoreMulti({ answers: answers({}) }, { judgeMode: "multi" });
  // every p is 0, so the sum is 0
  assert.equal(allYes.score, 0);
  assert.equal(allYes.tooltip, "");

  const ones = {};
  for (const key of Object.keys(WEIGHTS)) ones[key] = 1;
  // Every signal yes: 177 + (−90) = 87, which is red.
  const saturated = api.scoreMulti({ answers: answers(ones) }, {});
  assert.equal(saturated.score, 87);
  assert.equal(api.bandForScore(saturated.score), "red");
  const aiOnly = {};
  for (const key of Object.keys(WEIGHTS)) aiOnly[key] = key.startsWith("r") ? 1 : 0;
  assert.equal(api.scoreMulti({ answers: answers(aiOnly) }, {}).score, 100);

  const humans = {};
  for (const key of Object.keys(WEIGHTS)) humans[key] = key.startsWith("h") ? 1 : 0;
  assert.equal(api.scoreMulti({ answers: answers(humans) }, {}).score, 0);

  const mixed = { r1: 1, h1: 1 };
  const mid = api.scoreMulti({ answers: answers(mixed) }, {});
  assert.equal(mid.score, 5);
  assert.equal(api.bandForScore(19), "gray");
  assert.equal(api.bandForScore(20), "orange");
  assert.equal(api.bandForScore(44), "orange");
  assert.equal(api.bandForScore(45), "red");
  assert.match(mid.tooltip, /r1 先定性再展望 \+35/);
  assert.match(mid.tooltip, /h1 随口反应 -30/);
  assert.equal(mid.tooltip.includes("r2"), false);
});

test("a missing answer scores nothing", () => {
  const partial = answers({ r1: 1 });
  delete partial.r8;
  assert.throws(() => api.scoreMulti({ answers: partial }, {}), /missing noul for "r8"/);
  assert.throws(() => api.scoreMulti({ answers: {} }, { protocol: "cloudflare" }), /missing noul/);
});

test("detectText in multi mode fails closed and does not return a score", async () => {
  const broken = answers({ r1: 0.8 });
  delete broken.r8;
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ model: "jev-latest", answers: broken, usage: {} }),
    text: async () => ""
  });
  const full = answers({ r1: 0.8, h3: 0.8 });
  let body;
  const fetchFull = async (_url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ model: "jev-latest", answers: full }),
      text: async () => ""
    };
  };
  await assert.rejects(
    api.detectText("回复", "k", api.DEFAULT_API_SETTINGS, { fetch, parent: "原帖" }),
    /missing noul/
  );
  const result = await api.detectText("回复", "k", api.DEFAULT_API_SETTINGS, { fetch: fetchFull, parent: "原帖" });
  assert.equal(body.state, "原帖：原帖\n\n回复：回复");
  assert.equal(Object.keys(body.questions).length, 13);
  // 35*0.8 + -25*0.8 = 8
  assert.equal(result.probability, 8);
  assert.match(result.tooltip, /r1 /);
  assert.match(result.tooltip, /h3 /);
});

test("badge bands and tooltip live in the content script", () => {
  const src = fs.readFileSync(path.join(__dirname, "../ai-detector.js"), "utf8");
  assert.match(src, /probability >= 45/);
  assert.match(src, /probability >= 20/);
  assert.match(src, /badge\.title = state\.tooltip/);
  assert.match(src, /parent: parent \|\| ""/);
});

test("the Options read-only list is generated from MULTI_QUESTIONS", () => {
  const optionsJs = fs.readFileSync(path.join(__dirname, "../options.js"), "utf8");
  const optionsHtml = fs.readFileSync(path.join(__dirname, "../options.html"), "utf8");
  assert.match(optionsJs, /JevApi\.multiSignalRows\(\)/);
  assert.match(optionsJs, /\$\("multiSignals"\)\.hidden = !multi/);
  assert.match(optionsHtml, /id="multiSignalList"/);
  assert.match(optionsHtml, /id="judgeMode"/);
  const rows = api.multiSignalRows();
  assert.equal(rows.length, api.MULTI_QUESTIONS.length);
  for (let i = 0; i < rows.length; i++) {
    const source = api.MULTI_QUESTIONS[i];
    assert.equal(rows[i].key, source.key);
    assert.equal(rows[i].instructions, source.instructions);
    assert.equal(rows[i].criteriaTrue, source.criteria.true);
    assert.equal(rows[i].criteriaFalse, source.criteria.false);
    assert.equal(rows[i].weight, source.weight);
    assert.equal(rows[i].kind, source.kind);
    assert.equal(optionsJs.includes(source.instructions), false);
    assert.equal(optionsHtml.includes(source.instructions), false);
    assert.equal(optionsJs.includes(source.criteria.true), false);
    assert.equal(optionsHtml.includes(source.criteria.true), false);
  }
});
