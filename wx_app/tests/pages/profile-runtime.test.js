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

function loadPage({ profile = {}, analysis = {}, auth = {}, token = "", wx = {} } = {}) {
  let definition;
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  vm.runInNewContext(source, {
    require(request) {
      if (request === "../../services/profile") return profile;
      if (request === "../../services/analysis") return analysis;
      if (request === "../../services/auth") return auth;
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
