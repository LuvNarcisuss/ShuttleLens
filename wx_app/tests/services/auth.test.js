const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const servicePath = resolve(__dirname, "../../miniprogram/services/auth.js");

function loadService({ request, token = null, authMethod = null, wx = {} }) {
  let reloginHandler;
  const storage = { token, authMethod };
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
        clearAccessToken() { storage.token = null; storage.authMethod = null; },
        getAccessToken() { return storage.token; },
        getAuthMethod() { return storage.authMethod; },
        saveAccessToken(value, method) { storage.token = value; storage.authMethod = method; },
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
  assert.equal(storage.authMethod, "wechat");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: "https://api.example.com/api/auth/wechat/login",
    method: "POST",
    data: { login_code: "login-code" },
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.required_steps)), ["bind_phone"]);
});

test("account login sends credentials and stores the returned token", async () => {
  const calls = [];
  const { service, storage } = loadService({
    async request(input) {
      calls.push(input);
      return { access_token: "account-jwt", required_steps: [] };
    },
  });

  await service.loginByAccount("12345678", "password123");

  assert.equal(storage.token, "account-jwt");
  assert.equal(storage.authMethod, "account");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    url: "https://api.example.com/api/auth/account/login",
    method: "POST",
    data: { account_number: "12345678", password: "password123" },
  }]);
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

test("account session expiry clears credentials and returns to login without wx.login", async () => {
  const calls = [];
  const { service, storage, getReloginHandler } = loadService({
    authMethod: "account",
    token: "expired-account-jwt",
    wx: {
      login({ fail }) {
        calls.push("wx.login");
        fail(Object.assign(new Error("wx.login must not run"), { code: "UNEXPECTED_WECHAT_LOGIN" }));
      },
      reLaunch(input) { calls.push(input.url); },
      removeStorageSync() {},
    },
    async request() {
      throw new Error("account relogin must not call the API");
    },
  });

  await assert.rejects(
    () => getReloginHandler()(),
    (error) => error.code === "ACCOUNT_RELOGIN_REQUIRED"
      && error.message === "登录已失效，请使用账号密码重新登录",
  );

  assert.equal(storage.token, null);
  assert.equal(storage.authMethod, null);
  assert.deepEqual(calls, ["/pages/login/index"]);
  assert.equal(typeof service.loginByAccount, "function");
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
  assert.equal(storage.authMethod, null);
  assert.deepEqual(removed, [
    "current_user",
    "preview_task_id",
    "last_analysis_result",
    "analysis_cache",
    "tasks_cache",
    "career_stats_cache",
  ]);
});
