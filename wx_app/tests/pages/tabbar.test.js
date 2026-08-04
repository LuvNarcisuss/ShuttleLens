const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

test("app uses task center as the first tab and keeps analysis as a routed flow", () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, "../../miniprogram/app.json"), "utf8"));

  assert.deepEqual(config.pages, [
    "pages/tasks/index",
    "pages/analyze/index",
    "pages/profile/index",
    "pages/login/index",
    "pages/profile-edit/index",
    "pages/account-settings/index",
    "pages/result/index",
  ]);
  assert.deepEqual(config.tabBar.list, [
    {
      pagePath: "pages/tasks/index",
      text: "任务",
      iconPath: "assets/tabbar/tasks.png",
      selectedIconPath: "assets/tabbar/tasks-active.png",
    },
    {
      pagePath: "pages/profile/index",
      text: "我的",
      iconPath: "assets/tabbar/profile.png",
      selectedIconPath: "assets/tabbar/profile-active.png",
    },
  ]);
});

test("app exposes the 羽球拍档 blue-white theme and local tab icons", () => {
  const root = resolve(__dirname, "../../miniprogram");
  const app = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8"));
  assert.equal(app.window.navigationBarTitleText, "羽球拍档");
  assert.equal(app.window.navigationBarBackgroundColor, "#FFFFFF");
  assert.equal(app.tabBar.color, "#8C96A5");
  assert.equal(app.tabBar.selectedColor, "#0878E7");
  for (const item of app.tabBar.list) {
    assert.ok(existsSync(resolve(root, item.iconPath)));
    assert.ok(existsSync(resolve(root, item.selectedIconPath)));
  }
  assert.ok(existsSync(resolve(root, "assets/brand/shuttle.png")));
});
