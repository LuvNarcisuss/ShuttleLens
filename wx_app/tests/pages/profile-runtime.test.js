const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/profile");

function loadPage({ profile = {}, analysis = {}, token = "", wx = {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(request) {
      if (request === "../../services/profile") return profile;
      if (request === "../../services/analysis") return analysis;
      if (request === "../../services/token") return { getAccessToken: () => token };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    Page(value) { definition = value; }, wx, Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch); } };
}

test("profile page loads aggregated career stats without querying recent tasks", async () => {
  const calls = [];
  const page = loadPage({
    token: "token-1",
    profile: { async getCurrentProfile() { calls.push("profile"); return { nickname: "羽球小将", avatar_url: "avatar" }; } },
    analysis: { async getCareerStats() { calls.push("career"); return { total_matches: 2, matched_matches: 2, total_duration_sec: 600, total_rallies: 12, avg_speed_mps: 2, max_speed_mps: 4, total_distance_m: 100, avg_court_coverage: .25, win_count: 1, loss_count: 1, draw_count: 0, win_rate: .5 }; } },
  });

  await page.loadPageData();
  assert.deepEqual(calls, ["profile", "career"]);
  assert.equal(page.data.careerState, "ready");
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.careerMetrics.slice(0, 6))), [
    { key: "total_matches", label: "比赛场次", value: "2", unit: "场" },
    { key: "win_count", label: "胜", value: "1", unit: "" },
    { key: "loss_count", label: "负", value: "1", unit: "" },
    { key: "draw_count", label: "平", value: "0", unit: "" },
    { key: "win_rate", label: "胜率", value: "50%", unit: "" },
    { key: "total_duration", label: "总时长", value: "10分0秒", unit: "" },
  ]);
});

test("profile page resets career data on logout without calling protected services", async () => {
  const calls = [];
  const page = loadPage({ token: "", profile: { async getCurrentProfile() { calls.push("profile"); } }, analysis: { async getCareerStats() { calls.push("career"); } } });
  page.setData({ careerState: "ready", careerMetrics: [{ key: "old", value: "99" }] });
  await page.onShow();
  assert.deepEqual(calls, []);
  assert.equal(page.data.careerState, "empty");
  assert.equal(page.data.careerMetrics[0].value, "—");
});

test("profile page shows empty state when no selected-player matches exist", async () => {
  const page = loadPage({ token: "token-1", profile: { async getCurrentProfile() { return {}; } }, analysis: { async getCareerStats() { return { total_matches: 0 }; } } });
  await page.loadPageData();
  assert.equal(page.data.careerState, "empty");
});

test("profile page retains the analysis task center as an empty-state navigation", () => {
  const calls = [];
  const page = loadPage({ wx: { switchTab(input) { calls.push(input.url); }, navigateTo(input) { calls.push(input.url); } } });
  page.openAnalysisTasks();
  page.editProfile();
  page.openAccountSettings();
  assert.deepEqual(calls, ["/pages/tasks/index", "/pages/profile-edit/index", "/pages/account-settings/index"]);
});

test("profile template removes the recent-analysis box and only presents career data", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  assert.doesNotMatch(source, /listTasks|getAnalytics|safeTask/);
  assert.doesNotMatch(template, /最近分析|我的分析|task-list|tasksState/);
  assert.match(template, /羽球生涯/);
  assert.match(template, /career-record-grid/);
  assert.match(template, /最近比赛/);
});
