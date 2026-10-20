const API_FIELDS = ["baseUrl", "path", "authHeader", "authScheme", "model", "questionKey", "responsePath", "instructions"];
const NUMBER_FIELDS = ["concurrency", "maxReplies", "dailyAutoLimit"];
const DEFAULT_ORIGIN = "https://api.typesafe.ai/*";
const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

async function render() {
  const settings = await loadSettings();
  $("apiKey").value = settings.apiKey;
  for (const field of [...API_FIELDS, ...NUMBER_FIELDS]) $(field).value = settings[field];
  const mode = settings.triggerMode === "manual" ? "manual" : "auto";
  $("triggerModeAuto").checked = mode === "auto";
  $("triggerModeManual").checked = mode === "manual";
  $("autoUsage").textContent = `Auto-scan used today: ${await todayAutoCount()}`;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readForm() {
  const settings = {};
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

async function save() {
  const settings = readForm();
  if (!JevApi.originPattern(settings.baseUrl)) {
    setStatus("Base URL must be a valid http(s) URL.", "err");
    return false;
  }
  await chrome.storage.local.set({ settings, apiKey: $("apiKey").value.trim() });
  await render();
  setStatus("Saved.", "ok");
  return true;
}

// Must run from the click handler (user gesture) for chrome.permissions.request.
async function ensureHostPermission() {
  const origin = JevApi.originPattern($("baseUrl").value.trim() || DEFAULT_SETTINGS.baseUrl);
  if (!origin || origin === DEFAULT_ORIGIN) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  const granted = await ensureHostPermission();
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
