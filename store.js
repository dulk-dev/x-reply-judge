// Local storage: settings, score cache (v3:<m|s>:<p|r>:<tweet id>, 7 days), daily auto-scan counter.

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "apiKey";
const SCORE_CACHE_KEY = "scoreCache";
const AUTO_USAGE_KEY = "autoUsage";
const SCORE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  ...JevApi.DEFAULT_API_SETTINGS,
  concurrency: 4,
  maxReplies: 30,
  // "auto" = scan feed posts and status-page replies on arrival; "manual" = click only.
  triggerMode: "auto",
  dailyAutoLimit: 100
});

async function loadSettings() {
  const { [SETTINGS_KEY]: saved = {}, [API_KEY_KEY]: apiKey = "" } =
    await chrome.storage.local.get([SETTINGS_KEY, API_KEY_KEY]);
  const merged = { ...DEFAULT_SETTINGS, ...saved, apiKey };
  // Migrate the old "auto-scan own posts only" toggle into triggerMode.
  if (saved.triggerMode == null && typeof saved.autoScanOwn === "boolean") {
    merged.triggerMode = saved.autoScanOwn ? "auto" : "manual";
  }
  if (merged.triggerMode !== "auto" && merged.triggerMode !== "manual") {
    merged.triggerMode = DEFAULT_SETTINGS.triggerMode;
  }
  // Upgrades that predate the backend picker have no protocol. Keep them on TypeSafe Jev.
  merged.protocol = String(merged.protocol || "").trim().toLowerCase();
  if (merged.protocol !== "typesafe" && merged.protocol !== "cloudflare") {
    merged.protocol = "typesafe";
  }
  merged.cfModel = JevApi.cloudflareModel(merged.cfModel);
  merged.accountId = JevApi.normalizeAccountId(merged.accountId);
  merged.judgeMode = String(merged.judgeMode || "").trim().toLowerCase() === "single" ? "single" : "multi";
  // The old English default counts as unset, so upgrades pick up the criteria-backed question.
  merged.instructions = JevApi.resolveInstructions(merged.instructions);
  merged.criteriaTrue = JevApi.resolveCriteriaSide(
    merged.criteriaTrue, JevApi.LEGACY_CRITERIA_TRUE, DEFAULT_SETTINGS.criteriaTrue
  );
  merged.criteriaFalse = JevApi.resolveCriteriaSide(
    merged.criteriaFalse, JevApi.LEGACY_CRITERIA_FALSE, DEFAULT_SETTINGS.criteriaFalse
  );
  return merged;
}

function todayKey(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// Non-expired cache. Keys are v3:<m|s>:<p|r>:<tweet id> → { probability, tooltip, savedAt }.
async function loadScoreCache() {
  const { [SCORE_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(SCORE_CACHE_KEY);
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.savedAt < SCORE_CACHE_TTL)
  );
}

async function saveScores(results) {
  if (!results.length) return;
  const cache = await loadScoreCache();
  const savedAt = Date.now();
  for (const { key, probability, tooltip } of results) {
    if (!key) continue;
    cache[key] = { probability, tooltip: tooltip || "", savedAt };
  }
  await chrome.storage.local.set({ [SCORE_CACHE_KEY]: cache });
}

async function clearScoreCache() {
  await chrome.storage.local.remove(SCORE_CACHE_KEY);
}

async function todayAutoCount() {
  const { [AUTO_USAGE_KEY]: usage } = await chrome.storage.local.get(AUTO_USAGE_KEY);
  return usage?.date === todayKey() ? usage.count : 0;
}

async function addAutoCount(amount) {
  const count = await todayAutoCount();
  await chrome.storage.local.set({ [AUTO_USAGE_KEY]: { date: todayKey(), count: count + amount } });
}
