const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/account-settings");

function loadPage({ profile = {}, auth = {}, wx = {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(path) {
      if (path === "../../services/profile") return profile;
      if (path === "../../services/auth") return auth;
      throw new Error(`Unexpected dependency: ${path}`);
    },
    Page(value) { definition = value; },
    wx,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

test("loads the complete account ID and binds a replacement phone number", async () => {
  const calls = [];
  const page = loadPage({
    profile: {
      async getCurrentProfile() {
        return { id: "1160805361", masked_phone: "138****8000" };
      },
    },
    auth: {
      async bindPhone(code) {
        calls.push(code);
        return { masked_phone: "187****2735" };
      },
    },
    wx: {},
  });

  await page.onShow();

  assert.equal(page.data.accountId, "1160805361");
  assert.equal(page.data.maskedPhone, "138****8000");
  assert.equal(page.data.wechatStatus, "已绑定");
  assert.equal(page.data.isLoading, false);

  await page.replacePhone({ detail: { code: "phone-code" } });
  assert.deepEqual(calls, ["phone-code"]);
  assert.equal(page.data.maskedPhone, "187****2735");

  await page.replacePhone({ detail: { errMsg: "getPhoneNumber:fail user deny" } });
  assert.match(page.data.errorMessage, /拒绝/);
});

test("shows a default message for missing phone code and falls back after binding failure", async () => {
  const page = loadPage({
    auth: {
      async bindPhone() {
        throw new Error();
      },
    },
    wx: {},
  });

  await page.replacePhone({ detail: {} });
  assert.equal(page.data.errorMessage, "未获取到手机号授权凭证");

  await page.replacePhone({ detail: { code: "phone-code" } });
  assert.equal(page.data.errorMessage, "手机号更换失败");
  assert.equal(page.data.isLoading, false);
});

test("only logs out after the user confirms the logout modal", () => {
  const calls = [];
  const modals = [];
  const page = loadPage({
    auth: { logout() { calls.push("logout"); } },
    wx: {
      showModal(options) { modals.push(options); },
      switchTab({ url }) { calls.push(["switchTab", url]); },
    },
  });
  page.setData({ isLoading: false });

  page.confirmLogout();
  modals[0].success({ confirm: false });
  assert.deepEqual(calls, []);

  page.confirmLogout();
  modals[1].success({ confirm: true });
  assert.deepEqual(calls, ["logout", ["switchTab", "/pages/profile/index"]]);
});

test("confirms WeChat unlink and updates the bound state", async () => {
  const calls = [];
  const modals = [];
  const page = loadPage({
    auth: {
      async unbindWechat() { calls.push("unbindWechat"); return { wechat_bound: false }; },
    },
    wx: { showModal(options) { modals.push(options); } },
  });
  page.setData({ isLoading: false, wechatBound: true });

  page.onWechatAction();
  modals[0].success({ confirm: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["unbindWechat"]);
  assert.equal(page.data.wechatBound, false);
  assert.equal(page.data.wechatStatus, "未绑定");
});

test("switch account logs out and returns to the login page", () => {
  const calls = [];
  const page = loadPage({
    auth: { logout() { calls.push("logout"); } },
    wx: { reLaunch({ url }) { calls.push(["reLaunch", url]); } },
  });
  page.setData({ isLoading: false });

  page.onSwitchAccount();

  assert.deepEqual(calls, ["logout", ["reLaunch", "/pages/login/index"]]);
});

test("deactivation requires confirmation and then clears the local session", async () => {
  const calls = [];
  const modals = [];
  const page = loadPage({
    auth: {
      async deactivateAccount() { calls.push("deactivateAccount"); },
      logout() { calls.push("logout"); },
    },
    wx: { showModal(options) { modals.push(options); }, reLaunch({ url }) { calls.push(["reLaunch", url]); } },
  });
  page.setData({ isLoading: false });

  page.onDeactivate();
  modals[0].success({ confirm: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["deactivateAccount", "logout", ["reLaunch", "/pages/login/index"]]);
});
