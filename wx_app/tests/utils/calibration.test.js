const assert = require("node:assert/strict");
const test = require("node:test");

const {
  imageToScreen,
  screenToImage,
  validateCourtQuadrilateral,
} = require("../../miniprogram/utils/calibration");

test("coordinate round-trip stays within one source pixel across screen sizes", () => {
  const source = { x: 731, y: 419 };
  for (const viewport of [
    { left: 0, top: 80, width: 320, height: 180, imageWidth: 1280, imageHeight: 720 },
    { left: 16, top: 120, width: 390, height: 219.375, imageWidth: 1280, imageHeight: 720 },
    { left: 24, top: 160, width: 428, height: 240.75, imageWidth: 1280, imageHeight: 720 },
  ]) {
    const screen = imageToScreen(source, viewport);
    const restored = screenToImage(screen, viewport);
    assert.ok(Math.abs(restored.x - source.x) <= 1);
    assert.ok(Math.abs(restored.y - source.y) <= 1);
  }
});

test("court validation accepts a convex court and rejects crossed or tiny shapes", () => {
  const imageSize = { width: 1280, height: 720 };
  assert.deepEqual(
    validateCourtQuadrilateral([[300, 180], [980, 180], [1100, 680], [180, 680]], imageSize),
    { valid: true, message: "" },
  );
  assert.equal(
    validateCourtQuadrilateral([[300, 180], [1100, 680], [980, 180], [180, 680]], imageSize).valid,
    false,
  );
  assert.match(
    validateCourtQuadrilateral([[10, 10], [20, 10], [20, 15], [10, 15]], imageSize).message,
    /面积过小/,
  );
});
