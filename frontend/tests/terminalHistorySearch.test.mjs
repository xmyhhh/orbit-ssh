import assert from "node:assert/strict";
import test from "node:test";
import {
  matchRanges,
  matchesSearch,
  searchTerms,
} from "../src/terminalHistory.ts";

test("search terms split on whitespace and ignore case", () => {
  assert.deepEqual(searchTerms("  Nginx  状态 "), ["nginx", "状态"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("a plain substring always matches", () => {
  assert.equal(matchesSearch("systemctl status nginx", "nginx"), true);
  assert.equal(matchesSearch("systemctl status nginx", "NGINX"), true);
  assert.equal(matchesSearch("systemctl status nginx", "apache"), false);
});

test("every term has to match", () => {
  assert.equal(matchesSearch("systemctl status nginx --no-pager", "nginx status"), true);
  assert.equal(matchesSearch("systemctl status nginx --no-pager", "nginx apache"), false);
});

test("a Chinese term matches inside a sentence", () => {
  assert.equal(matchesSearch("查看当前配置并验证语法", "配置"), true);
  assert.equal(matchesSearch("查看当前配置并验证语法", "重启"), false);
});

test("an in-order fallback stays inside a tight window", () => {
  // "重新启动" keeps 重 and 启 close together, so it still matches.
  assert.equal(matchesSearch("重新启动服务", "重启"), true);
  // The same characters far apart in a transcript must not match.
  const transcript = `重${"x".repeat(500)}启`;
  assert.equal(matchesSearch(transcript, "重启"), false);
});

test("match ranges point at the matched text", () => {
  const ranges = matchRanges("systemctl status nginx", "nginx");
  assert.equal(ranges.length, 1);
  assert.equal("systemctl status nginx".slice(ranges[0].start, ranges[0].end), "nginx");
  assert.deepEqual(matchRanges("systemctl status nginx", ""), []);
});
