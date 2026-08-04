const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/profile-edit");

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
    decodeURIComponent,
    encodeURIComponent,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

test("chooseAvatar temp path is uploaded before nickname and avatar URL are saved", async () => {
  const calls = [];
  const page = loadPage({
    profile: {
      async getCurrentProfile() { return { nickname: "", avatar_url: "" }; },
      async uploadAvatar(path) { calls.push(["upload", path]); return "https://api.example.com/avatar.jpg"; },
      async saveProfile(value) { calls.push(["save", value]); return { onboarding_status: "active" }; },
    },
    wx: { navigateBack() { calls.push("back"); } },
  });
  await page.onLoad({});
  page.onChooseAvatar({ detail: { avatarUrl: "wxfile://avatar-temp" } });
  page.onNicknameInput({ detail: { value: "羽球小将" } });

  await page.submit();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["upload", "wxfile://avatar-temp"],
    ["save", { nickname: "羽球小将", avatarUrl: "https://api.example.com/avatar.jpg" }],
    "back",
  ]);
});

test("nickname cleared by WeChat on blur blocks submission and remains recoverable", async () => {
  const calls = [];
  const page = loadPage({
    profile: { async uploadAvatar() { calls.push("upload"); }, async saveProfile() { calls.push("save"); } },
    wx: {},
  });
  page.setData({ avatarTempPath: "wxfile://avatar-temp", nickname: "候选昵称" });

  page.onNicknameBlur({ detail: { value: "" } });
  await page.submit();

  assert.equal(page.data.errorMessage, "昵称未通过微信安全校验，请重新填写");
  assert.deepEqual(calls, []);
});

test("profile editor uses the account-settings row style and delegates phone management", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  const style = readFileSync(resolve(pageDirectory, "index.wxss"), "utf8");

  assert.doesNotMatch(source, /bindPhone|replacePhone|maskedPhone|phoneFailureMessage/);
  assert.doesNotMatch(template, /手机号|更换手机号|getPhoneNumber/);
  assert.match(template, /profile-form-card/);
  assert.match(template, /profile-form-row/);
  assert.match(template, /profile-avatar-row/);
  assert.match(template, /profile-form-divider/);
  assert.match(template, /profile-nickname-row/);
  assert.match(style, /profile-form-card/);
  assert.match(style, /min-height: 112rpx/);
  assert.match(style, /width: 150rpx/);
  assert.match(style, /height: 96rpx/);
});
