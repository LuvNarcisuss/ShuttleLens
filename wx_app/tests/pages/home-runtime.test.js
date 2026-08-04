const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const pageDirectory = resolve(__dirname, "../../miniprogram/pages/home");
test("home page has one JavaScript runtime entry that registers login", () => {
  assert.equal(existsSync(resolve(pageDirectory, "index.ts")), false);
  assert.match(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), /login\s*\(/);
});

test("quick login requests WeChat profile from the login button handler", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");

  assert.match(source, /wx\.getUserProfile/);
  assert.match(source, /typeof wx\.getUserProfile/);
  assert.match(source, /userInfo\.nickName/);
  assert.match(source, /userInfo\.avatarUrl/);
});

test("home page logs in with authorized profile data and loads an existing profile", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");

  assert.match(source, /const \{ getCurrentProfile \} = require\("\.\.\/\.\.\/services\/profile"\)/);
  assert.match(source, /const \{ getAccessToken \} = require\("\.\.\/\.\.\/services\/token"\)/);
  assert.match(source, /const response = await ensureLogin\(\{ nickname: userInfo\.nickName, avatarUrl: userInfo\.avatarUrl \}\)/);
  assert.match(source, /profile: response\.user/);
  assert.match(source, /async onShow\(\)/);
  assert.match(source, /await getCurrentProfile\(\)/);
});
