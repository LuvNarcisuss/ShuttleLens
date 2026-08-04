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
