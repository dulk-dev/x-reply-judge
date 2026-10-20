// Pure helpers for classifying X (Twitter) pages. Used by the content script and unit tests.
// Verified against current x.com routes: home feed, explore/search streams, profiles, status detail.

(function (root) {
  const STATUS_ID_PATTERN = /\/status\/(\d+)/;

  // Top-level paths that are not user profiles.
  const RESERVED_TOP_PATHS = new Set([
    "",
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "settings",
    "compose",
    "i",
    "hashtag",
    "bookmarks",
    "lists",
    "communities",
    "tos",
    "privacy",
    "login",
    "signup",
    "logout"
  ]);

  /**
   * Classify an X pathname into a page kind the extension cares about.
   * - "status": post detail with replies (`/user/status/id`)
   * - "feed": timelines that show post cards (home, explore, search, bookmarks, lists, profiles)
   * - "other": pages with no scorable post stream (messages, settings, compose, …)
   */
  function classifyXPath(pathname) {
    const path = String(pathname || "");
    if (STATUS_ID_PATTERN.test(path)) return "status";

    if (path === "/" || path === "/home") return "feed";
    if (path === "/explore" || path.startsWith("/explore/")) return "feed";
    if (path === "/search" || path.startsWith("/search")) return "feed";
    if (path === "/i/bookmarks" || path.startsWith("/i/bookmarks/")) return "feed";
    if (path.startsWith("/i/lists/")) return "feed";
    if (path.startsWith("/hashtag/")) return "feed";

    // Profile timelines: /user, /user/with_replies, /user/media, /user/likes, /user/highlights
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 1) {
      const handle = segments[0].toLowerCase();
      if (!RESERVED_TOP_PATHS.has(handle) && /^[a-z0-9_]{1,15}$/i.test(segments[0])) {
        const tab = segments[1];
        if (
          !tab ||
          tab === "with_replies" ||
          tab === "media" ||
          tab === "likes" ||
          tab === "highlights" ||
          tab === "articles"
        ) {
          return "feed";
        }
      }
    }

    return "other";
  }

  function statusIdFromPath(pathname) {
    return String(pathname || "").match(STATUS_ID_PATTERN)?.[1] || null;
  }

  const api = { classifyXPath, statusIdFromPath, STATUS_ID_PATTERN, RESERVED_TOP_PATHS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XPageDetect = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
