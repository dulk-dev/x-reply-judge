(() => {
  if (window.__xReplyJudgeCleaner) return;
  window.__xReplyJudgeCleaner = true;

  const BUTTON_ATTRIBUTE = "data-x-jev-hide-block";
  const TOAST_ID = "x-jev-hide-block-toast";
  const STATUS_ID_PATTERN = /\/status\/(\d+)/;
  // Labels below match X's own localized menu text (Chinese and English UIs); they are DOM matchers, not UI strings.
  const HIDE_LABELS = ["隐藏回复", "隐藏此回复", "Hide reply"];
  const BLOCK_WORDS = ["屏蔽", "封锁", "Block"];
  let operationInProgress = false;

  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  function normalize(value) {
    return (value || "").replace(/\s+/g, "").trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  async function waitFor(find, timeout = 5000, interval = 100) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function currentMainStatusId() {
    return location.pathname.match(STATUS_ID_PATTERN)?.[1] || null;
  }

  function isSupportedPage() {
    return Boolean(
      currentMainStatusId() ||
      location.pathname === "/notifications" ||
      location.pathname.startsWith("/notifications/")
    );
  }

  function articlePermalink(article) {
    const time = article.querySelector("time");
    return time?.closest('a[href*="/status/"]')?.getAttribute("href") || "";
  }

  function articleAuthorHandle(article) {
    const permalink = articlePermalink(article);
    return permalink.match(/^\/([^/]+)\/status\/\d+/)?.[1]?.toLowerCase() || null;
  }

  function loggedInHandle() {
    const profileLink = document.querySelector(
      'a[data-testid="AppTabBar_Profile_Link"][href]'
    );
    const profileMatch = profileLink
      ?.getAttribute("href")
      ?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (profileMatch) return profileMatch[1].toLowerCase();

    const accountSwitcher = document.querySelector(
      '[data-testid="SideNav_AccountSwitcher_Button"]'
    );
    if (!accountSwitcher) return null;

    const switcherLink = [...accountSwitcher.querySelectorAll("a[href]")].find((link) => {
      return /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || "");
    });
    const linkMatch = switcherLink
      ?.getAttribute("href")
      ?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (linkMatch) return linkMatch[1].toLowerCase();

    return accountSwitcher.innerText.match(/@([A-Za-z0-9_]{1,15})/)?.[1]?.toLowerCase() || null;
  }

  function isOwnArticle(article, ownHandle) {
    const authorHandle = articleAuthorHandle(article);
    return Boolean(authorHandle && ownHandle && authorHandle === ownHandle);
  }

  function findActionGroup(article) {
    return [...article.querySelectorAll('[role="group"]')].find((group) => {
      return (
        group.querySelector('[data-testid="reply"]') &&
        group.querySelector('[data-testid="like"], [data-testid="unlike"]')
      );
    });
  }

  function showToast(message, type = "success") {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      left: "50%",
      bottom: "28px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "999px",
      background: type === "success" ? "#0f1419" : "#e0245e",
      color: "#fff",
      font: "600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.24)",
      pointerEvents: "none"
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function visibleMenuItems() {
    return [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
  }

  function findHideReplyMenuItem() {
    return visibleMenuItems().find((item) => {
      const text = normalize(item.innerText || item.getAttribute("aria-label"));
      return HIDE_LABELS.some((label) => text.includes(normalize(label)));
    });
  }

  function findBlockAccountMenuItem() {
    return visibleMenuItems().find((item) => {
      if (item.matches('[data-testid="block"]') || item.querySelector('[data-testid="block"]')) {
        return true;
      }
      const text = normalize(item.innerText || item.getAttribute("aria-label"));
      return /^(屏蔽|封锁)@/.test(text) || /^Block@/i.test(text);
    });
  }

  function visibleDialogs() {
    return [
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [data-testid="confirmationSheetDialog"]'
      )
    ].filter(isVisible);
  }

  function dialogIncludes(dialog, words) {
    const text = normalize(dialog.innerText || dialog.getAttribute("aria-label"));
    return words.some((word) => text.includes(normalize(word)));
  }

  function visibleButtons(root) {
    return [...root.querySelectorAll('button, [role="button"]')].filter(isVisible);
  }

  function findConfirmButton(dialog, exactLabels) {
    const testIdButton = dialog.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (testIdButton && isVisible(testIdButton)) return testIdButton;

    return visibleButtons(dialog).find((button) => {
      const text = normalize(button.innerText || button.getAttribute("aria-label"));
      return exactLabels.some((label) => text === normalize(label));
    });
  }

  function findHideDialog() {
    return visibleDialogs().find((dialog) => {
      return dialogIncludes(dialog, ["隐藏回复", "Hide reply"]);
    });
  }

  function findBlockDialog() {
    return visibleDialogs().find((dialog) => {
      return (
        dialogIncludes(dialog, BLOCK_WORDS) &&
        Boolean(findConfirmButton(dialog, ["屏蔽", "封锁", "Block"]))
      );
    });
  }

  async function closeOpenMenu() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
    );
    await sleep(100);
  }

  async function confirmBlockAccount() {
    const blockDialog = await waitFor(findBlockDialog, 6000);
    if (!blockDialog) throw new Error("Block confirmation dialog did not appear");

    const confirmBlock = findConfirmButton(blockDialog, ["屏蔽", "封锁", "Block"]);
    if (!confirmBlock) throw new Error("Could not find the Block confirm button");
    confirmBlock.click();
    await waitFor(() => !isVisible(blockDialog), 4000);
  }

  // Simplified Chinese X calls Mute "隐藏 @user"; Traditional Chinese uses "靜音".
  function findMuteAccountMenuItem(handle) {
    return visibleMenuItems().find((item) => {
      if (item.matches('[data-testid="mute"]') || item.querySelector('[data-testid="mute"]')) {
        return true;
      }
      const text = normalize(item.innerText || item.getAttribute("aria-label")).toLowerCase();
      if (/回复|對話|对话|conversation|reply/.test(text)) return false;
      const mentionsAuthor = handle ? text.includes(`@${handle}`) : text.includes("@");
      return mentionsAuthor && /隐藏|靜音|静音|mute/.test(text);
    });
  }

  function menuItemTexts() {
    return visibleMenuItems()
      .map((item) => (item.innerText || item.getAttribute("aria-label") || "").trim())
      .filter(Boolean)
      .join(" / ");
  }

  function findMuteDialog() {
    return visibleDialogs().find((dialog) => {
      return (
        dialogIncludes(dialog, ["隐藏", "靜音", "静音", "Mute"]) &&
        Boolean(findConfirmButton(dialog, ["隐藏", "靜音", "静音", "Mute"]))
      );
    });
  }

  // Mute usually applies immediately; some versions show a confirmation dialog.
  async function confirmMuteIfAsked() {
    const dialog = await waitFor(findMuteDialog, 1200);
    if (!dialog) return;
    findConfirmButton(dialog, ["隐藏", "靜音", "静音", "Mute"])?.click();
    await waitFor(() => !isVisible(dialog), 3000);
  }

  async function dismissDialog(dialog) {
    const cancel = visibleButtons(dialog).find((button) => {
      const text = normalize(button.innerText || button.getAttribute("aria-label"));
      return ["取消", "Cancel"].includes(text);
    });
    if (cancel) cancel.click();
    else await closeOpenMenu();
    await waitFor(() => !isVisible(dialog), 3000);
  }

  async function openArticleMenu(article) {
    const caret = article.isConnected && article.querySelector('[data-testid="caret"]');
    if (!caret || !isVisible(caret)) return false;
    caret.click();
    const menuReady = await waitFor(() => visibleMenuItems().length > 0, 4000);
    if (!menuReady) await closeOpenMenu();
    return Boolean(menuReady);
  }

  // Mute or block the author from the already-open menu.
  async function actOnAuthorFromMenu(action, handle) {
    if (action === "block") {
      const blockItem = findBlockAccountMenuItem();
      if (!blockItem) {
        const items = menuItemTexts();
        await closeOpenMenu();
        throw new Error(`"Block" not found in menu. Items: ${items || "none"}`);
      }
      blockItem.click();
      await confirmBlockAccount();
      return;
    }

    const muteItem = findMuteAccountMenuItem(handle);
    if (!muteItem) {
      const items = menuItemTexts();
      await closeOpenMenu();
      throw new Error(`"Mute @user" not found in menu. Items: ${items || "none"}`);
    }
    muteItem.click();
    await confirmMuteIfAsked();
  }

  const ACTION_TEXT = {
    mute: { done: "Muted", person: "mute the author" },
    block: { done: "Blocked", person: "block the author" }
  };

  // action: "mute" mutes the author; "block" hides the reply first, then blocks the author.
  // Runs ONLY from a user click on the injected buttons; nothing here is triggered automatically.
  async function hideReplyThenAct(article, button, action) {
    if (operationInProgress) {
      showToast("Previous action is still running", "error");
      return;
    }

    operationInProgress = true;
    const group = button.parentElement;
    const buttons = [...(group?.querySelectorAll("button") || [button])];
    const originalText = button.textContent;
    buttons.forEach((item) => (item.disabled = true));
    button.textContent = "Working…";
    let replyHidden = false;
    const handle = articleAuthorHandle(article);

    try {
      if (!(await openArticleMenu(article))) {
        throw new Error("Could not find this reply's \"More\" menu");
      }

      // "Mute" only mutes the author and does not hide the reply, avoiding X's "Block?" prompt.
      if (action === "mute") {
        await actOnAuthorFromMenu("mute", handle);
        if (button.isConnected) button.textContent = ACTION_TEXT.mute.done;
        showToast("Author muted");
        return;
      }

      const hideItem = findHideReplyMenuItem();
      if (!hideItem) {
        // "Hide reply" is only available on your own posts; act on the author directly.
        await actOnAuthorFromMenu(action, handle);
        if (button.isConnected) button.textContent = ACTION_TEXT[action].done;
        showToast(`Cannot hide replies here; did ${ACTION_TEXT[action].person} instead`);
        return;
      }

      hideItem.click();

      // Some versions confirm "Hide reply" first, others apply it directly.
      const firstDialog = await waitFor(() => findHideDialog() || findBlockDialog(), 3500);
      if (firstDialog && firstDialog === findHideDialog()) {
        const confirmHide = findConfirmButton(firstDialog, ["隐藏", "确认", "Hide"]);
        if (!confirmHide) throw new Error("Could not find the Hide reply confirm button");
        confirmHide.click();
        await sleep(250);
      }
      replyHidden = true;

      // After hiding a reply X usually asks whether to block the author.
      const blockPrompt = await waitFor(findBlockDialog, 3500);
      if (action === "block" && blockPrompt) {
        await confirmBlockAccount();
      } else {
        if (blockPrompt) await dismissDialog(blockPrompt);
        if (!(await openArticleMenu(article))) {
          throw new Error("Reply disappeared from the page; its menu is gone");
        }
        await actOnAuthorFromMenu(action, handle);
      }

      if (button.isConnected) button.textContent = ACTION_TEXT[action].done;
      showToast(`Reply hidden; did ${ACTION_TEXT[action].person}`);
    } catch (error) {
      const message = error.message || "Action did not complete";
      showToast(
        replyHidden ? `Reply hidden, but could not ${ACTION_TEXT[action].person}: ${message}` : message,
        "error"
      );
      if (button.isConnected) button.textContent = originalText;
      buttons.forEach((item) => (item.disabled = false));
    } finally {
      operationInProgress = false;
    }
  }

  function createActionButton(article, action) {
    const button = document.createElement("button");
    button.type = "button";
    const label = action === "block" ? "Block" : "Mute";
    const hover =
      action === "block"
        ? { color: "rgb(244, 33, 46)", background: "rgba(244, 33, 46, .1)" }
        : { color: "rgb(29, 155, 240)", background: "rgba(29, 155, 240, .1)" };
    button.textContent = label;
    button.title =
      action === "block"
        ? "Hide this reply, then block the author"
        : "Mute the author (the reply stays visible)";
    button.setAttribute("aria-label", button.title);
    Object.assign(button.style, {
      appearance: "none",
      border: "0",
      borderRadius: "999px",
      background: "transparent",
      color: "rgb(113, 118, 123)",
      cursor: "pointer",
      font: "500 12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      lineHeight: "28px",
      padding: "0 8px",
      whiteSpace: "nowrap"
    });
    button.addEventListener("mouseenter", () => {
      if (button.disabled) return;
      button.style.background = hover.background;
      button.style.color = hover.color;
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "transparent";
      button.style.color = "rgb(113, 118, 123)";
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideReplyThenAct(article, button, action);
    });
    return button;
  }

  function createButton(article) {
    const group = document.createElement("span");
    group.setAttribute(BUTTON_ATTRIBUTE, "true");
    Object.assign(group.style, { display: "inline-flex", alignItems: "center" });
    group.append(createActionButton(article, "mute"), createActionButton(article, "block"));
    return group;
  }

  function installButtons() {
    if (!isSupportedPage()) {
      document
        .querySelectorAll(`[${BUTTON_ATTRIBUTE}]`)
        .forEach((button) => button.remove());
      return;
    }

    const ownHandle = loggedInHandle();
    if (!ownHandle) return;

    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const existingButton = article.querySelector(`[${BUTTON_ATTRIBUTE}]`);
      const authorHandle = articleAuthorHandle(article);

      // Buttons appear on any post not written by the logged-in account;
      // stale buttons on your own posts are removed.
      if (!authorHandle || isOwnArticle(article, ownHandle)) {
        existingButton?.remove();
        continue;
      }
      if (existingButton) continue;

      const actionGroup = findActionGroup(article);
      if (!actionGroup) continue;
      actionGroup.appendChild(createButton(article));
    }
  }

  let scheduled = false;
  function scheduleInstall() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      installButtons();
    });
  }

  new MutationObserver(scheduleInstall).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("popstate", scheduleInstall);
  // X navigates via the History API; the interval covers cases with no popstate and no DOM change.
  setInterval(scheduleInstall, 1000);
  scheduleInstall();
})();
