const API_FIELDS = ["baseUrl", "path", "authHeader", "authScheme", "model", "questionKey", "responsePath", "instructions", "criteriaTrue", "criteriaFalse"];
const NUMBER_FIELDS = ["concurrency", "maxReplies", "dailyAutoLimit"];
const DEFAULT_ORIGIN = "https://api.typesafe.ai/*";
const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function selectedProtocol() {
  return $("protocol").value === "cloudflare" ? "cloudflare" : "typesafe";
}

function syncProtocolUi() {
  const cloudflare = selectedProtocol() === "cloudflare";
  $("cloudflareFields").hidden = !cloudflare;
  $("typesafeAdvanced").hidden = cloudflare;
  $("protocolHelpTypesafe").hidden = cloudflare;
  $("protocolHelpCloudflare").hidden = !cloudflare;
  $("apiKeyLabel").textContent = cloudflare ? "Cloudflare API token" : "TypeSafe API key";
  $("apiKeyHelpTypesafe").hidden = cloudflare;
  $("apiKeyHelpCloudflare").hidden = !cloudflare;
  syncJudgeUi();
}

function renderMultiSignals() {
  const list = $("multiSignalList");
  list.replaceChildren();
  for (const row of JevApi.multiSignalRows()) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const sign = row.weight > 0 ? `+${row.weight}` : String(row.weight);
    title.textContent = `${row.key} · ${row.kind === "ai" ? "AI" : "human"} · ${sign}`;
    const instructions = document.createElement("div");
    instructions.textContent = row.instructions;
    const yes = document.createElement("div");
    yes.textContent = `yes: ${row.criteriaTrue}`;
    const no = document.createElement("div");
    no.textContent = `no: ${row.criteriaFalse}`;
    item.append(title, instructions, yes, no);
    list.appendChild(item);
  }
}

function syncJudgeUi() {
  const multi = $("judgeMode").value !== "single";
  $("singleQuestion").hidden = multi;
  $("multiSignals").hidden = !multi;
  if (multi) renderMultiSignals();
}

async function render() {
  const settings = await loadSettings();
  $("apiKey").value = settings.apiKey;
  $("protocol").value = settings.protocol === "cloudflare" ? "cloudflare" : "typesafe";
  $("judgeMode").value = settings.judgeMode === "single" ? "single" : "multi";
  $("accountId").value = settings.accountId || "";
  $("cfModel").value = JevApi.cloudflareModel(settings.cfModel);
  for (const field of [...API_FIELDS, ...NUMBER_FIELDS]) $(field).value = settings[field];
  const mode = settings.triggerMode === "manual" ? "manual" : "auto";
  $("triggerModeAuto").checked = mode === "auto";
  $("triggerModeManual").checked = mode === "manual";
  $("autoUsage").textContent = `Auto-scan used today: ${await todayAutoCount()}`;
  syncProtocolUi();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readForm() {
  const settings = {};
  settings.protocol = selectedProtocol();
  settings.judgeMode = $("judgeMode").value === "single" ? "single" : "multi";
  settings.accountId = JevApi.normalizeAccountId($("accountId").value);
  settings.cfModel = JevApi.cloudflareModel($("cfModel").value);
  for (const field of API_FIELDS) settings[field] = $(field).value.trim();
  for (const field of API_FIELDS) {
    if (!settings[field] && field !== "authScheme") settings[field] = DEFAULT_SETTINGS[field];
  }
  settings.concurrency = clampInt($("concurrency").value, 1, 16, DEFAULT_SETTINGS.concurrency);
  settings.maxReplies = clampInt($("maxReplies").value, 1, 200, DEFAULT_SETTINGS.maxReplies);
  settings.dailyAutoLimit = clampInt($("dailyAutoLimit").value, 0, 10000, DEFAULT_SETTINGS.dailyAutoLimit);
  settings.triggerMode = $("triggerModeManual").checked ? "manual" : "auto";
  return settings;
}

function formError(settings) {
  if (settings.protocol === "cloudflare") {
    if (!settings.accountId) return "Cloudflare Account ID is required.";
    return "";
  }
  if (!JevApi.originPattern(settings.baseUrl)) return "Base URL must be a valid http(s) URL.";
  return "";
}

// Must run from the click handler (user gesture) for chrome.permissions.request.
async function authorize(settings) {
  if (settings.protocol === "cloudflare") {
    return chrome.permissions.request({ origins: [JevApi.CF_HOST_PERMISSION] });
  }
  const origin = JevApi.originPattern(settings.baseUrl || DEFAULT_SETTINGS.baseUrl);
  if (!origin || origin === DEFAULT_ORIGIN) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function save() {
  const settings = readForm();
  const problem = formError(settings);
  if (problem) {
    setStatus(problem, "err");
    return false;
  }
  await chrome.storage.local.set({ settings, apiKey: $("apiKey").value.trim() });
  await render();
  setStatus("Saved.", "ok");
  return true;
}

$("protocol").addEventListener("change", syncProtocolUi);
$("judgeMode").addEventListener("change", syncJudgeUi);

$("save").addEventListener("click", async () => {
  const settings = readForm();
  const problem = formError(settings);
  if (problem) return setStatus(problem, "err");
  if (settings.protocol === "cloudflare") {
    const granted = await authorize(settings);
    if (!granted) return setStatus("Host permission was not granted.", "err");
  }
  await save();
});

$("test").addEventListener("click", async () => {
  const settings = readForm();
  const problem = formError(settings);
  if (problem) return setStatus(problem, "err");
  const granted = await authorize(settings);
  if (!granted) return setStatus("Host permission was not granted.", "err");
  if (!(await save())) return;
  setStatus("Testing…");
  const result = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
  if (result?.ok) {
    setStatus(`OK in ${result.ms} ms. Sample reply scored AI ${result.probability}%${result.model ? ` (model ${result.model})` : ""}.`, "ok");
  } else {
    setStatus(`Failed: ${result?.error || "unknown error"}`, "err");
  }
});

$("clearCache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  setStatus("Cache cleared.", "ok");
});

$("reset").addEventListener("click", () => {
  for (const field of API_FIELDS) $(field).value = DEFAULT_SETTINGS[field];
  setStatus("Endpoint defaults restored. Click Save to keep them.");
});

render();
