const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/profile");

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function loadPage({ profile = {}, analysis = {}, auth = {}, result = {}, token = "", wx = {} } = {}) {
  let definition;
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  vm.runInNewContext(source, {
    require(request) {
      if (request === "../../services/profile") return profile;
      if (request === "../../services/analysis") return analysis;
      if (request === "../../services/auth") return auth;
      if (request === "../../services/result") return result;
      if (request === "../../services/token") return { getAccessToken: () => token };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    Page(value) { definition = value; },
    wx,
    console,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

test("profile page displays persisted avatar nickname masked phone and safe task fields", async () => {
  const profileResult = deferred();
  const taskResult = deferred();
  const calls = [];
  const page = loadPage({
    token: "token-1",
    profile: { getCurrentProfile() { calls.push("profile"); return profileResult.promise; } },
    analysis: { listTasks() { calls.push("tasks"); return taskResult.promise; } },
  });

  const loading = page.onShow();
  assert.deepEqual(calls, ["profile", "tasks"]);
  profileResult.resolve({
    nickname: "羽球小将",
    avatar_url: "https://example.com/avatar.png",
    masked_phone: "187****2735",
    onboarding_status: "active",
    required_steps: [],
  });
  taskResult.resolve({
    items: [{ id: "task-1", status: "running", progress: 40, created_at: "2026-07-21T10:00:00Z", input_video_path: "C:\\private\\match.mp4", result: { video: "private/output.mp4" } }],
  });
  await loading;

  assert.equal(page.data.displayName, "羽球小将");
  assert.equal(page.data.maskedPhone, "187****2735");
  assert.equal(page.data.isLoggedIn, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.tasks[0])), {
    id: "task-1",
    status: "running",
    statusLabel: "分析中",
    progress: 40,
    createdAt: "2026-07-21T10:00:00Z",
  });
});

test("login entry navigates to the dedicated login page without requesting profile", () => {
  const calls = [];
  const page = loadPage({
    wx: { navigateTo(input) { calls.push(input.url); } },
  });

  page.login();

  assert.deepEqual(calls, ["/pages/login/index?redirect=%2Fpages%2Fprofile%2Findex"]);
});

test("incomplete profile opens profile editor and logout only clears local session", async () => {
  const calls = [];
  const page = loadPage({
    auth: { logout() { calls.push("logout"); } },
    wx: { navigateTo(input) { calls.push(input.url); } },
  });
  page.setData({ isLoggedIn: true, requiredSteps: ["complete_profile"], tasks: [{ id: "task" }] });

  page.editProfile();
  await page.logout();

  assert.deepEqual(calls, ["/pages/profile-edit/index", "logout"]);
  assert.equal(page.data.isLoggedIn, false);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.tasks)), []);
});

test("completed task opens the independent result page directly", () => {
  const calls = [];
  const page = loadPage({
    wx: {
      navigateTo(input) { calls.push(input.url); },
    },
  });
  page.setData({ tasks: [{ id: "task-9", status: "succeeded", progress: 100, createdAt: "today" }] });

  page.openTask({ currentTarget: { dataset: { taskId: "task-9" } } });

  assert.deepEqual(calls, ["/pages/result/index?task_id=task-9"]);
});

test("profile page loads the latest succeeded upper-player career snapshot", async () => {
  const calls = [];
  const page = loadPage({
    profile: { getCurrentProfile: async () => ({ id: "player-12345678" }) },
    analysis: {
      listTasks: async () => ({
        items: [
          { id: "task-running", status: "running", progress: 40 },
          { id: "task-success", status: "succeeded", progress: 100 },
          { id: "task-older", status: "failed", progress: 100 },
        ],
      }),
    },
    result: {
      getAnalytics: async (taskId) => {
        calls.push(taskId);
        return {
          quality: { confidence: "high" },
          players: {
            upper: {
              average_speed_mps: { value: 2.5, unit: "m/s", available: true },
              maximum_speed_mps: { value: 4, unit: "m/s", available: true },
              distance_m: { value: 42.5, unit: "m", available: true },
              court_coverage_ratio: { value: 0.25, unit: "ratio", available: true },
              zones: { front: 0.2, mid: 0.5, back: 0.3 },
              sides: { left: 0.45, right: 0.55 },
            },
          },
        };
      },
    },
  });

  await page.loadPageData();

  assert.deepEqual(calls, ["task-success"]);
  assert.equal(page.data.latestSucceededTaskId, "task-success");
  assert.equal(page.data.careerState, "ready");
  assert.equal(page.data.tasks.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.careerMetrics.map(({ value, unit }) => [value, unit]))),
    [
      ["9.0", "km/h"], ["14.4", "km/h"], ["42.5", "m"],
      ["25", "%"], ["20", "%"], ["50", "%"],
      ["30", "%"], ["45", "%"], ["55", "%"],
    ],
  );
});

test("profile page shows empty career metrics when no task has succeeded", async () => {
  const page = loadPage({
    profile: { getCurrentProfile: async () => ({ id: "player-123" }) },
    analysis: { listTasks: async () => ({ items: [{ id: "task-running", status: "running" }] }) },
  });

  await page.loadPageData();

  assert.equal(page.data.careerState, "empty");
  assert.equal(page.data.careerMetrics.every((item) => item.value === "—"), true);
});

test("profile page preserves profile and recent tasks when career analytics is unavailable", async () => {
  const page = loadPage({
    profile: { getCurrentProfile: async () => ({ id: "account-123456789", nickname: "羽球小将" }) },
    analysis: {
      listTasks: async () => ({
        items: [
          { id: "task-success", status: "succeeded", progress: 100 },
          { id: "task-running", status: "running", progress: 40 },
          { id: "task-older", status: "failed", progress: 100 },
        ],
      }),
    },
    result: { getAnalytics: async () => { throw new Error("analytics unavailable"); } },
  });

  await page.loadPageData();

  assert.equal(page.data.careerState, "unavailable");
  assert.equal(page.data.careerErrorMessage, "本次结果暂无生涯数据");
  assert.equal(page.data.displayName, "羽球小将");
  assert.equal(page.data.accountDisplay, "…23456789");
  assert.equal(page.data.tasks.length, 2);
});

test("profile page opens account settings, task list, and latest career result", () => {
  const calls = [];
  const page = loadPage({
    wx: {
      navigateTo(input) { calls.push(["navigateTo", input.url]); },
      switchTab(input) { calls.push(["switchTab", input.url]); },
    },
  });

  page.editProfile();
  page.openAccountSettings();
  page.openAnalysisTasks();
  page.setData({ latestSucceededTaskId: "task-success" });
  page.openCareerResult();

  assert.deepEqual(calls, [
    ["navigateTo", "/pages/profile-edit/index"],
    ["navigateTo", "/pages/account-settings/index"],
    ["switchTab", "/pages/tasks/index"],
    ["navigateTo", "/pages/result/index?task_id=task-success"],
  ]);
});

test("profile template has login entry and presents only safe task fields", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");

  const page = loadPage();
  assert.equal(page.data.isLoading, true);
  assert.doesNotMatch(source, /getUserProfile/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(template, /wx:if="\{\{!isLoggedIn && !isLoading\}\}"[^>]*>微信快捷登录<\/button>/s);
  assert.doesNotMatch(template, /isLoggingIn/);
  assert.match(template, /maskedPhone/);
  assert.match(template, /完善资料|编辑资料/);
  assert.match(template, /退出登录/);
  assert.match(template, /item\.statusLabel/);
  assert.match(template, /item\.progress/);
  assert.match(template, /item\.createdAt/);
  assert.doesNotMatch(template, /input_video_path|template_path|item\.result/);
});
