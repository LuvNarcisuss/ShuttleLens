const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const servicePath = resolve(__dirname, "../../miniprogram/services/auth.js");

function loadService({ request, token = null, wx = {} }) {
  let reloginHandler;
  const storage = { token };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(servicePath, "utf8"), {
    module,
    exports: module.exports,
    require(path) {
      if (path === "./http") return {
        request,
        setReloginHandler(handler) { reloginHandler = handler; },
      };
      if (path === "./token") return {
        clearAccessToken() { storage.token = null; },
        getAccessToken() { return storage.token; },
        saveAccessToken(value) { storage.token = value; },
      };
      if (path === "./config") return { API_BASE_URL: "https://api.example.com/api" };
      throw new Error(`Unexpected dependency: ${path}`);
    },
    wx,
    Promise,
  }, { filename: servicePath });
  return { service: module.exports, storage, getReloginHandler: () => reloginHandler };
}

test("wechat login sends only login_code and stores the returned token", async () => {
  const calls = [];
  const { service, storage } = loadService({
    wx: { login({ success }) { success({ code: "login-code" }); } },
    async request(input) {
      calls.push(input);
      return { access_token: "jwt", required_steps: ["bind_phone"] };
    },
  });

  const response = await service.ensureLogin();

  assert.equal(storage.token, "jwt");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: "https://api.example.com/api/auth/wechat/login",
    method: "POST",
    data: { login_code: "login-code" },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.required_steps)), ["bind_phone"]);
});

test("phone binding sends only phone_code to its dedicated endpoint", async () => {
  const calls = [];
  const { service } = loadService({
    async request(input) { calls.push(input); return { required_steps: ["complete_profile"] }; },
  });

  await service.bindPhone("phone-code");

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: "https://api.example.com/api/auth/wechat/phone",
    method: "POST",
    data: { phone_code: "phone-code" },
  }]);
});

test("account lifecycle actions use guarded server endpoints", async () => {
  const calls = [];
  const { service } = loadService({
    wx: { login({ success }) { success({ code: "rebind-code" }); } },
    async request(input) { calls.push(input); return { status: "deactivated" }; },
  });

  await service.unbindWechat();
  await service.bindWechat();
  await service.deactivateAccount();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: "https://api.example.com/api/auth/wechat/unbind", method: "POST" },
    { url: "https://api.example.com/api/auth/wechat/bind", method: "POST", data: { login_code: "rebind-code" } },
    { url: "https://api.example.com/api/auth/deactivate", method: "POST" },
  ]);
});

test("session restore only requests current user when a local token exists", async () => {
  const calls = [];
  const withoutToken = loadService({ request: async (input) => calls.push(input) });
  const withToken = loadService({
    token: "jwt",
    request: async (input) => { calls.push(input); return { onboarding_status: "active" }; },
  });

  assert.equal(await withoutToken.service.restoreSession(), null);
  assert.equal((await withToken.service.restoreSession()).onboarding_status, "active");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/api/auth/me");
});

test("401 relogin handler uses wx.login and never asks for profile data", async () => {
  const calls = [];
  const { getReloginHandler } = loadService({
    wx: { login({ success }) { calls.push("wx.login"); success({ code: "fresh-code" }); } },
    async request(input) { calls.push(input.data); return { access_token: "fresh-jwt" }; },
  });

  await getReloginHandler()();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ["wx.login", { login_code: "fresh-code" }]);
});

test("logout clears local token and caches without deleting the server account", () => {
  const removed = [];
  const { service, storage } = loadService({
    token: "jwt",
    request: async () => { throw new Error("logout must not call the server"); },
    wx: { removeStorageSync(key) { removed.push(key); } },
  });

  service.logout();

  assert.equal(storage.token, null);
  assert.deepEqual(removed, [
    "current_user",
    "preview_task_id",
    "last_analysis_result",
    "analysis_cache",
    "tasks_cache",
    "career_stats_cache",
  ]);
});
