// Unit tests for page-detect.js. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyXPath, statusIdFromPath } = require("../page-detect.js");

test("status detail pages", () => {
  assert.equal(classifyXPath("/elonmusk/status/1234567890123456789"), "status");
  assert.equal(classifyXPath("/user_name/status/1/photo/1"), "status");
  assert.equal(statusIdFromPath("/alice/status/998877"), "998877");
});

test("home and explore feeds", () => {
  assert.equal(classifyXPath("/"), "feed");
  assert.equal(classifyXPath("/home"), "feed");
  assert.equal(classifyXPath("/explore"), "feed");
  assert.equal(classifyXPath("/explore/tabs/news"), "feed");
  assert.equal(classifyXPath("/search"), "feed");
});

test("bookmarks, lists, hashtags", () => {
  assert.equal(classifyXPath("/i/bookmarks"), "feed");
  assert.equal(classifyXPath("/i/bookmarks/all"), "feed");
  assert.equal(classifyXPath("/i/lists/12345"), "feed");
  assert.equal(classifyXPath("/hashtag/AI"), "feed");
});

test("profile timelines count as feed", () => {
  assert.equal(classifyXPath("/elonmusk"), "feed");
  assert.equal(classifyXPath("/elonmusk/with_replies"), "feed");
  assert.equal(classifyXPath("/elonmusk/media"), "feed");
  assert.equal(classifyXPath("/elonmusk/likes"), "feed");
  assert.equal(classifyXPath("/elonmusk/highlights"), "feed");
});

test("non-scorable pages are other", () => {
  assert.equal(classifyXPath("/messages"), "other");
  assert.equal(classifyXPath("/notifications"), "other");
  assert.equal(classifyXPath("/settings"), "other");
  assert.equal(classifyXPath("/compose/post"), "other");
  assert.equal(classifyXPath("/i/chat"), "other");
});

test("statusIdFromPath returns null when absent", () => {
  assert.equal(statusIdFromPath("/home"), null);
  assert.equal(statusIdFromPath(""), null);
});
