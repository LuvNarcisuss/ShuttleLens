const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const miniprogramRoot = resolve(__dirname, "../../miniprogram");

function readPageFile(page, extension) {
  return readFileSync(resolve(miniprogramRoot, `${page}.${extension}`), "utf8");
}

function declarationsFor(css, selector) {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter(([, selectors]) => selectors.split(",").some((item) => item.trim() === selector))
    .map(([, , declarations]) => declarations)
    .join("\n");
}

test("every registered page keeps the 羽球拍档 brand in its effective navigation title", () => {
  const app = JSON.parse(readFileSync(resolve(miniprogramRoot, "app.json"), "utf8"));

  for (const page of app.pages) {
    const pageConfig = JSON.parse(readPageFile(page, "json"));
    const effectiveTitle = pageConfig.navigationBarTitleText || app.window.navigationBarTitleText;
    assert.match(effectiveTitle, /羽球拍档/, `${page} should retain the brand title`);
  }
});

test("highlight editor keeps fixed chrome around a vertically scrollable form", () => {
  const template = readPageFile("pages/result/index", "wxml");
  const styles = readPageFile("pages/result/index", "wxss");
  const sheetStart = template.indexOf('<view class="result-sheet"');
  const titleStart = template.indexOf('<text class="editor-title"', sheetStart);
  const scrollStart = template.indexOf('<scroll-view class="editor-scroll" scroll-y>', titleStart);
  const scrollEnd = template.indexOf("</scroll-view>", scrollStart);
  const actionsStart = template.indexOf('<view class="editor-actions">', scrollEnd);

  assert.ok(sheetStart >= 0);
  assert.ok(sheetStart < titleStart && titleStart < scrollStart);
  assert.ok(scrollStart < template.indexOf('data-field="title"', scrollStart));
  assert.ok(template.indexOf('data-field="selected"', scrollStart) < scrollEnd);
  assert.ok(scrollEnd < actionsStart);
  assert.match(declarationsFor(styles, ".result-sheet"), /max-height\s*:/);
  assert.match(declarationsFor(styles, ".result-sheet"), /overflow\s*:\s*hidden/);
  assert.match(declarationsFor(styles, ".editor-scroll"), /min-height\s*:\s*0/);
  assert.match(declarationsFor(styles, ".editor-scroll"), /flex\s*:\s*1/);
});

test("critical mobile actions expose an 88rpx minimum touch height", () => {
  const targets = {
    "pages/tasks/index": [".task-card", ".action"],
    "pages/analyze/index": ["button", ".zoom-row view text"],
    "pages/result/index": [
      ".fullscreen",
      ".save-button",
      ".settings-button",
      ".scope-tab",
      ".player-switch text",
      ".highlight-main",
      ".edit-button",
      ".restore",
      ".editor-actions button",
    ],
    "pages/profile/index": [
      ".login",
      ".preview",
      ".profile-edit-action",
      ".profile-danger-action",
    ],
    "pages/profile-edit/index": [".secondary", ".primary"],
  };

  for (const [page, selectors] of Object.entries(targets)) {
    const styles = readPageFile(page, "wxss");
    for (const selector of selectors) {
      assert.match(
        declarationsFor(styles, selector),
        /min-height\s*:\s*88rpx/,
        `${page} ${selector} should expose an 88rpx touch target`,
      );
    }
  }
});

test("non-tab scroll pages reserve the device bottom safe area", () => {
  for (const page of ["pages/analyze/index", "pages/result/index", "pages/profile-edit/index"]) {
    assert.match(readPageFile(page, "wxss"), /env\(safe-area-inset-bottom\)/, `${page} needs safe-area spacing`);
  }
});
