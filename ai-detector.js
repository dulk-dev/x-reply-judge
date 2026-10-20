(() => {
  if (window.__xReplyJudge) return;
  window.__xReplyJudge = true;

  const BADGE_ATTRIBUTE = "data-x-jev-badge";
  const SCAN_BUTTON_ID = "x-jev-scan-button";
  const TOAST_ID = "x-jev-toast";
  const STATUS_ID_PATTERN = /\/status\/(\d+)/;
  // On your own posts, new replies are collected for up to 2 s and sent as one batch.
  // Cache lookups cost nothing, so they wait less.
  const AUTO_DELAY = 2000;
  const LOOKUP_DELAY = 500;
  const MAX_AUTO_ATTEMPTS = 2;

  // tweet id -> { probability }. X recycles reply nodes, so badges are re-attached by id.
  const scores = new Map();
  const lookedUp = new Set();
  const autoAttempts = new Map();
  let busy = false;
  let queueTimer = null;
  // Why auto-scan is paused: disabled | limit | needsConfig | error
  let autoPausedReason = null;

  const currentMainStatusId = () => location.pathname.match(STATUS_ID_PATTERN)?.[1] || null;

  function articlePermalink(article) {
    const time = article.querySelector("time");
    return time?.closest('a[href*="/status/"]')?.getAttribute("href") || "";
  }
  const articleStatusId = (article) => articlePermalink(article).match(STATUS_ID_PATTERN)?.[1] || null;
  const articleAuthorHandle = (article) =>
    articlePermalink(article).match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase() || null;
  const articleText = (article) =>
    article.querySelector('[data-testid="tweetText"]')?.innerText.trim() || "";

  function loggedInHandle() {
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href]')?.getAttribute("href");
    return href?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1]?.toLowerCase() || null;
  }

  function findActionGroup(article) {
    return [...article.querySelectorAll('[role="group"]')].find(
      (group) =>
        group.querySelector('[data-testid="reply"]') &&
        group.querySelector('[data-testid="like"], [data-testid="unlike"]')
    );
  }

  // Edited tweets may have a permalink id that differs from the URL, so fall back step by step.
  function findMainArticle(articles, mainId) {
    const byPermalink = articles.find((article) => articleStatusId(article) === mainId);
    if (byPermalink) return byPermalink;
    const byAnyLink = articles.find((article) =>
      [...article.querySelectorAll('a[href*="/status/"]')].some(
        (link) => link.getAttribute("href").match(STATUS_ID_PATTERN)?.[1] === mainId
      )
    );
    if (byAnyLink) return byAnyLink;
    // The reply composer sits right below the main post.
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!composer) return null;
    return articles
      .filter((article) => article.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
      .pop() || null;
  }

  const pathAuthorHandle = () =>
    location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/)?.[1]?.toLowerCase() || null;

  // Replies below the main post written by other accounts.
  // Each item is { id, text }; the id stays local (cache key), only text is sent to the API.
  function collectPage() {
    const mainId = currentMainStatusId();
    if (!mainId) return null;
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const mainArticle = findMainArticle(articles, mainId);
    if (!mainArticle) return null;

    const ownHandle = loggedInHandle();
    const items = [];
    for (const article of articles) {
      if (article === mainArticle) continue;
      if (!(mainArticle.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const id = articleStatusId(article);
      const author = articleAuthorHandle(article);
      const text = articleText(article);
      if (!id || !author || !text || author === ownHandle) continue;
      items.push({ id, text });
    }
    const mainAuthor = articleAuthorHandle(mainArticle) || pathAuthorHandle();
    return { items, own: Boolean(ownHandle && mainAuthor === ownHandle) };
  }

  function showToast(message, type = "success") {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed", left: "50%", bottom: "72px", transform: "translateX(-50%)",
      zIndex: "2147483647", padding: "10px 16px", borderRadius: "999px",
      background: type === "success" ? "#0f1419" : "#e0245e", color: "#fff",
      font: "600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.24)", pointerEvents: "none"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  // >=70 red, >=31 orange, otherwise gray.
  function badgeColors(probability) {
    if (probability >= 70) return { color: "rgb(244, 33, 46)", background: "rgba(244, 33, 46, .12)" };
    if (probability >= 31) return { color: "rgb(214, 128, 0)", background: "rgba(255, 173, 31, .16)" };
    return { color: "rgb(113, 118, 123)", background: "rgba(113, 118, 123, .1)" };
  }

  function renderBadge(article, state) {
    const actionGroup = findActionGroup(article);
    if (!actionGroup) return;
    let badge = article.querySelector(`[${BADGE_ATTRIBUTE}]`);
    if (!badge) {
      badge = document.createElement("span");
      badge.setAttribute(BADGE_ATTRIBUTE, "true");
      Object.assign(badge.style, {
        alignSelf: "center", borderRadius: "999px",
        font: "600 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        lineHeight: "22px", padding: "0 8px", whiteSpace: "nowrap"
      });
      actionGroup.appendChild(badge);
    }
    if (state === "pending") {
      badge.textContent = "AI …";
      Object.assign(badge.style, badgeColors(0));
      return;
    }
    badge.textContent = `AI ${state.probability}%`;
    Object.assign(badge.style, badgeColors(state.probability));
  }

  function clearPendingBadges() {
    document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach((badge) => {
      const article = badge.closest('article[data-testid="tweet"]');
      if (!article || !scores.has(articleStatusId(article))) badge.remove();
    });
  }

  // force = true overwrites existing badges (e.g. the pending one).
  function renderScoredBadges(force = false) {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const result = scores.get(articleStatusId(article));
      if (result && (force || !article.querySelector(`[${BADGE_ATTRIBUTE}]`))) renderBadge(article, result);
    }
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(response);
      });
    });
  }

  async function analyze(items, mode) {
    busy = true;
    updateScanButton();
    if (mode !== "lookup") {
      const ids = new Set(items.map((item) => item.id));
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        if (ids.has(articleStatusId(article))) renderBadge(article, "pending");
      }
    }
    try {
      let response;
      try {
        response = await sendToBackground({
          type: "ANALYZE_ITEMS",
          items: items.map(({ id, text }) => ({ id, text })),
          mode
        });
      } catch (_error) {
        response = { ok: false, error: "Extension was updated. Please reload the page.", results: [], batchIds: [] };
      }
      for (const result of response?.results || []) scores.set(result.id, { probability: result.probability });
      if (mode === "lookup") items.forEach((item) => lookedUp.add(item.id));
      for (const id of response?.batchIds || []) autoAttempts.set(id, (autoAttempts.get(id) || 0) + 1);
      renderScoredBadges(true);

      if (mode === "auto") {
        if (response?.autoDisabled) autoPausedReason = "disabled";
        else if (response?.limitReached) autoPausedReason = "limit";
        else if (response?.needsConfig) autoPausedReason = "needsConfig";
        else if (!response?.ok) autoPausedReason = "error";
      }
      return response || { ok: false, error: "Analysis failed" };
    } finally {
      busy = false;
      clearPendingBadges();
      updateScanButton();
    }
  }

  // New content: auto-scan on your own posts, cache lookup everywhere else.
  function queueCheck() {
    if (queueTimer || busy) return;
    const page = collectPage();
    if (!page) return;
    const unscored = page.items.filter((item) => !scores.has(item.id));
    const needsAuto =
      page.own && !autoPausedReason &&
      unscored.some((item) => (autoAttempts.get(item.id) || 0) < MAX_AUTO_ATTEMPTS);
    const needsLookup = unscored.some((item) => !lookedUp.has(item.id));
    if (!needsAuto && !needsLookup) return;
    queueTimer = setTimeout(runQueued, needsAuto ? AUTO_DELAY : LOOKUP_DELAY);
  }

  async function runQueued() {
    queueTimer = null;
    if (busy) return;
    const page = collectPage();
    if (!page) return;
    const unscored = page.items.filter((item) => !scores.has(item.id));
    if (page.own && !autoPausedReason) {
      const autoItems = unscored.filter((item) => (autoAttempts.get(item.id) || 0) < MAX_AUTO_ATTEMPTS);
      if (autoItems.length) {
        const response = await analyze(autoItems, "auto");
        if (!response.ok && autoPausedReason === "error") showToast(`Auto-scan paused: ${response.error}`, "error");
        return;
      }
    }
    const lookupItems = unscored.filter((item) => !lookedUp.has(item.id));
    if (lookupItems.length) await analyze(lookupItems, "lookup");
  }

  async function manualScan() {
    if (busy) {
      showToast("Analysis already in progress", "error");
      return { ok: false };
    }
    const page = collectPage();
    if (!page) {
      showToast("Open a post's detail page to scan its replies", "error");
      return { ok: false };
    }
    const unscored = page.items.filter((item) => !scores.has(item.id));
    if (!unscored.length) {
      showToast(page.items.length ? "All replies on this page are already scored" : "No replies to scan on this page");
      return { ok: true };
    }
    const response = await analyze(unscored, "manual");
    if (!response.ok) {
      if (response.needsConfig) sendToBackground({ type: "OPEN_OPTIONS" }).catch(() => {});
      showToast(response.error || "Analysis failed", "error");
      return { ok: false };
    }
    if (autoPausedReason === "error" || autoPausedReason === "needsConfig") autoPausedReason = null;
    const analyzed = response.analyzed ?? response.results.length;
    let message = `Scored ${analyzed} repl${analyzed === 1 ? "y" : "ies"}`;
    if (response.failed) message += `, ${response.failed} failed`;
    if (response.remaining) message += `. ${response.remaining} left, click again to continue`;
    showToast(message, response.failed ? "error" : "success");
    return { ok: true };
  }

  function scanButtonLabel(page) {
    if (!page) return "Scan replies";
    if (!page.own) return busy ? "Scoring…" : "Scan replies";
    if (busy) return "Auto-scanning…";
    switch (autoPausedReason) {
      case "limit": return "Daily auto limit reached · Click to scan";
      case "disabled": return "Auto-scan off · Click to scan";
      case "needsConfig": return "API not configured · Open options";
      case "error": return "Auto-scan error · Click to retry";
      default: {
        const count = page.items.filter((item) => scores.has(item.id)).length;
        return `Auto-scan · ${count} scored`;
      }
    }
  }

  function updateScanButton() {
    const button = document.getElementById(SCAN_BUTTON_ID);
    if (!button) return;
    const label = scanButtonLabel(collectPage());
    if (button.textContent !== label) button.textContent = label;
    button.disabled = busy;
  }

  function installScanButton() {
    const existing = document.getElementById(SCAN_BUTTON_ID);
    if (!currentMainStatusId()) {
      existing?.remove();
      return;
    }
    if (existing) return updateScanButton();
    const button = document.createElement("button");
    button.id = SCAN_BUTTON_ID;
    button.type = "button";
    Object.assign(button.style, {
      position: "fixed", right: "24px", bottom: "24px", zIndex: "2147483646",
      appearance: "none", border: "0", borderRadius: "999px", background: "#1d9bf0",
      color: "#fff", cursor: "pointer",
      font: "700 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      padding: "10px 16px", boxShadow: "0 6px 24px rgba(0,0,0,.24)"
    });
    button.addEventListener("click", () => {
      if (autoPausedReason === "needsConfig") {
        sendToBackground({ type: "OPEN_OPTIONS" }).catch(() => {});
        return;
      }
      manualScan();
    });
    document.body.appendChild(button);
    updateScanButton();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCAN_REPLIES") return;
    manualScan().then(sendResponse);
    return true;
  });

  // Settings changed (toggle, limit, key): resume auto-scan. Cache/counter writes do not count.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const dataKeys = ["scoreCache", "autoUsage"];
    if (changes.scoreCache && !changes.scoreCache.newValue) {
      scores.clear();
      lookedUp.clear();
      document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach((badge) => badge.remove());
    }
    if (Object.keys(changes).some((key) => !dataKeys.includes(key))) {
      autoPausedReason = null;
      autoAttempts.clear();
    }
  });

  let scheduled = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installScanButton();
      renderScoredBadges();
      queueCheck();
    });
  }

  new MutationObserver(scheduleUpdate).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", scheduleUpdate);
  setInterval(scheduleUpdate, 1000);
  scheduleUpdate();
})();
