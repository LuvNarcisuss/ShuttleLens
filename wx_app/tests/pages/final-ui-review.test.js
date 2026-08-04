const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const miniprogramRoot = resolve(__dirname, "../../miniprogram");

function readPageFile(page, extension) {
  return readFileSync(resolve(miniprogramRoot, `${page}.${extension}`), "utf8");
}

test("every registered page keeps the 羽球拍档 brand in its effective navigation title", () => {
  const app = JSON.parse(readFileSync(resolve(miniprogramRoot, "app.json"), "utf8"));

  for (const page of app.pages) {
    const pageConfig = JSON.parse(readPageFile(page, "json"));
    const effectiveTitle = pageConfig.navigationBarTitleText || app.window.navigationBarTitleText;
    assert.match(effectiveTitle, /羽球拍档/, `${page} should retain the brand title`);
  }
});
