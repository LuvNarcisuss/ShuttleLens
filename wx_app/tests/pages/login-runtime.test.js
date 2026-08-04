const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/login");

function loadPage({ auth = {}, wx = {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(path) {
      if (path === "../../services/auth") return auth;
      throw new Error(`Unexpected dependency: ${path}`);
    },
    Page(value) { definition = value; },
    wx,
    Promise,
    decodeURIComponent,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

test("agreement is required before the page can call wx.login through auth service", async () => {
  const calls = [];
  const page = loadPage({
    auth: { async ensureLogin() { calls.push("login"); } },
    wx: { showToast(input) { calls.push(input.title); } },
  });

  await page.login();
  assert.deepEqual(calls, ["请先阅读并同意服务协议与隐私保护指引"]);

  page.onAgreementChange({ detail: { value: ["agreed"] } });
  await page.login();
  assert.deepEqual(calls, ["请先阅读并同意服务协议与隐私保护指引", "login"]);
});

test("required_steps move login from phone binding to profile completion", async () => {
  const calls = [];
  const page = loadPage({
    auth: {
      async ensureLogin() { return { required_steps: ["bind_phone", "complete_profile"] }; },
      async bindPhone(code) { calls.push(code); return { required_steps: ["complete_profile"] }; },
    },
    wx: {},
  });
  page.setData({ agreed: true });

  await page.login();
  assert.equal(page.data.step, "phone_binding");
  await page.bindPhone({ detail: { code: "phone-code" } });
  assert.deepEqual(calls, ["phone-code"]);
  assert.equal(page.data.step, "profile_completion");
});

test("phone authorization refusal cancellation and quota errors have distinct messages", async () => {
  const cases = [
    ["getPhoneNumber:fail user deny", "你已拒绝手机号授权，可点击按钮重新尝试"],
    ["getPhoneNumber:fail cancel", "已取消手机号授权，可稍后重试"],
    ["getPhoneNumber:fail no quota", "手机号验证额度不足，请稍后再试"],
  ];
  for (const [errMsg, expected] of cases) {
    const page = loadPage({ auth: { async bindPhone() {} }, wx: {} });
    await page.bindPhone({ detail: { errMsg } });
    assert.equal(page.data.errorMessage, expected);
  }
});

test("active session completes and returns to an internal redirect", async () => {
  const calls = [];
  const page = loadPage({
    auth: { async restoreSession() { return { required_steps: [] }; } },
    wx: { redirectTo(input) { calls.push(input.url); } },
  });

  page.onLoad({ redirect: encodeURIComponent("/pages/analyze/index") });
  await page.onShow();

  assert.equal(page.data.step, "complete");
  assert.deepEqual(calls, ["/pages/analyze/index"]);
});
