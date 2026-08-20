const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/result");

function loadPage({ result = {}, download = {}, wx = {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(path) {
      if (path === "../../services/result") return result;
      if (path === "../../services/download") return download;
      throw new Error(`Unexpected dependency: ${path}`);
    },
    Page(value) { definition = value; },
    wx,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch); } };
}

test("non-succeeded tasks show pending or failed state without loading resources", async () => {
  const loaded = [];
  const pending = loadPage({ result: { async getResultTask() { return { status: "running", progress: 45 }; }, async loadResultResources() { loaded.push("pending"); } }, wx: {} });
  const failed = loadPage({ result: { async getResultTask() { return { status: "failed", progress: 100, error_message: "分析失败" }; }, async loadResultResources() { loaded.push("failed"); } }, wx: {} });
  await pending.onLoad({ task_id: "task-pending" });
  await failed.onLoad({ task_id: "task-failed" });
  assert.equal(pending.data.pageState, "pending");
  assert.equal(pending.data.progress, 45);
  assert.equal(failed.data.pageState, "failed");
  assert.equal(failed.data.errorMessage, "分析失败");
  assert.deepEqual(loaded, []);
});

test("succeeded task loads authenticated video and chart previews", async () => {
  const calls = [];
  const page = loadPage({ result: {
    async getResultTask(id) { calls.push(["task", id]); return { status: "succeeded", result: { video: "private", visualizations: ["a", "b"] } }; },
    async loadResultResources(id, descriptor) { calls.push(["resources", id, descriptor]); return { videoPath: "wxfile://video", imagePaths: ["wxfile://a", "wxfile://b"] }; },
  }, wx: {} });
  await page.onLoad({ task_id: "task-ready" });
  assert.equal(page.data.pageState, "ready");
  assert.equal(page.data.videoPath, "wxfile://video");
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.imagePaths)), ["wxfile://a", "wxfile://b"]);
  assert.equal(calls.length, 2);
});

test("result page exposes badge data only for recorded match results", async () => {
  const cases = [
    ["win", "胜"],
    ["loss", "负"],
    ["draw", "平"],
    [null, ""],
  ];

  for (const [matchResult, expectedLabel] of cases) {
    const page = loadPage({
      result: {
        async getResultTask() {
          return {
            status: "succeeded",
            progress: 100,
            player_position: "upper",
            match_result: matchResult,
            result: {},
          };
        },
        async loadResultResources() { return { videoPath: "", imagePaths: [] }; },
      },
      wx: {},
    });

    await page.onLoad({ task_id: `task-${matchResult || "legacy"}` });

    assert.equal(page.data.matchResult, matchResult || "");
    assert.equal(page.data.matchResultLabel, expectedLabel);
  }
});

test("result layout keeps the hero compact and groups match result before dashboard confidence", () => {
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  const styles = readFileSync(resolve(pageDirectory, "index.wxss"), "utf8");
  const heroStart = template.indexOf('<view class="result-hero">');
  const heroEnd = template.indexOf("</view>", heroStart);

  assert.doesNotMatch(template.slice(heroStart, heroEnd), /match-result/);
  assert.match(
    template,
    /<view class="card-title">\s*<text>数据看板<\/text>\s*<view class="dashboard-meta">\s*<text wx:if="\{\{matchResultLabel\}\}" class="match-result match-result-\{\{matchResult\}\}">\{\{matchResultLabel\}\}<\/text>\s*<text class="confidence">可信度 \{\{quality\.confidence \|\| 'unknown'\}\}<\/text>\s*<\/view>\s*<\/view>\s*<text class="quality-note"/s,
  );
  assert.match(styles, /\.dashboard-meta\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*10rpx;/s);
  assert.doesNotMatch(styles.match(/\.match-result\s*\{([^}]*)\}/s)?.[1] || "", /margin-top/);
});

test("resource failure leaves a recoverable result page state", async () => {
  const page = loadPage({ result: { async getResultTask() { return { status: "succeeded", result: { video: "private" } }; }, async loadResultResources() { throw new Error("资源缺失"); } }, wx: {} });
  await page.onLoad({ task_id: "task-resource-fail" });
  assert.equal(page.data.pageState, "resource_error");
  assert.equal(page.data.errorMessage, "资源缺失");
});

test("resource failure keeps the recorded match result available in page state", async () => {
  const page = loadPage({
    result: {
      async getResultTask() {
        return {
          status: "succeeded",
          progress: 100,
          player_position: "upper",
          match_result: "loss",
          result: { video: "private" },
        };
      },
      async loadResultResources() { throw new Error("资源缺失"); },
    },
    wx: {},
  });

  await page.onLoad({ task_id: "task-resource-fail-with-result" });

  assert.equal(page.data.pageState, "resource_error");
  assert.equal(page.data.matchResult, "loss");
  assert.equal(page.data.matchResultLabel, "负");
});

test("legacy succeeded task remains viewable when structured results are absent", async () => {
  const page = loadPage({ result: {
    async getResultTask() { return { status: "succeeded", result: { video: "private" } }; },
    async loadResultResources() { return { videoPath: "wxfile://legacy", imagePaths: [] }; },
    async getAnalytics() { throw new Error("not found"); },
    async getHighlights() { throw new Error("not found"); },
  }, wx: {} });
  await page.onLoad({ task_id: "task-legacy" });
  assert.equal(page.data.pageState, "ready");
  assert.equal(page.data.videoPath, "wxfile://legacy");
  assert.equal(page.data.structuredUnavailable, true);
});

test("result page does not provide a custom landscape fullscreen control", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");

  assert.doesNotMatch(source, /enterFullscreen|requestFullScreen|onFullscreenChange|isFullscreen/);
  assert.doesNotMatch(template, /横屏全屏|bindfullscreenchange|class="fullscreen"/);
});

test("chart preview opens the original image list", () => {
  const calls = [];
  const page = loadPage({ wx: { previewImage(input) { calls.push(input); } } });
  page.setData({ imagePaths: ["wxfile://a", "wxfile://b"] });
  page.previewImage({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ current: "wxfile://b", urls: ["wxfile://a", "wxfile://b"] }]);
});

test("result template uses the native contained video without a custom fullscreen event", () => {
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  assert.match(template, /<video[^>]+id="result-video"[^>]+controls[^>]+object-fit="contain"/s);
  assert.doesNotMatch(template, /bindfullscreenchange|横屏全屏/);
});

test("video save downloads with progress before saving to the album", async () => {
  const calls = [];
  const page = loadPage({
    download: {
      async downloadTaskFile(input) { calls.push(["download", input.taskId, input.kind]); input.onProgress(61); return "wxfile://saved-video"; },
      async saveVideoToAlbum(path) { calls.push(["save-video", path]); },
      isAlbumPermissionDenied() { return false; },
    },
    wx: { showToast(input) { calls.push(["toast", input.title]); } },
  });
  page.setData({ taskId: "task-save", videoPath: "wxfile://preview" });

  await page.saveVideo();

  assert.deepEqual(calls, [["download", "task-save", "video"], ["save-video", "wxfile://saved-video"], ["toast", "已保存到相册"]]);
  assert.equal(page.data.downloadProgress, 100);
  assert.equal(page.data.savingVideo, false);
});

test("chart can be saved independently", async () => {
  const calls = [];
  const page = loadPage({
    download: {
      async downloadTaskFile(input) { calls.push([input.kind, input.index]); return "wxfile://chart"; },
      async saveImageToAlbum(path) { calls.push(["save-image", path]); },
      isAlbumPermissionDenied() { return false; },
    },
    wx: { showToast() {} },
  });
  page.setData({ taskId: "task-chart", imagePaths: ["preview"] });

  await page.saveImage({ currentTarget: { dataset: { index: 0 } } });

  assert.deepEqual(calls, [["visualization", 0], ["save-image", "wxfile://chart"]]);
  assert.equal(page.data.savingImageIndex, -1);
});

test("permission denial exposes recovery and opens settings only after explicit click", async () => {
  let settingsCalls = 0;
  const denied = { errMsg: "saveVideoToPhotosAlbum:fail auth deny" };
  const page = loadPage({
    download: {
      async downloadTaskFile() { return "wxfile://video"; },
      async saveVideoToAlbum() { throw denied; },
      isAlbumPermissionDenied(error) { return error === denied; },
      async openAlbumSettings() { settingsCalls += 1; return false; },
    },
    wx: { showToast() {} },
  });
  page.setData({ taskId: "task-denied", videoPath: "preview" });

  await page.saveVideo();
  assert.equal(page.data.permissionDenied, true);
  assert.equal(settingsCalls, 0);

  await page.openAlbumSettings();
  assert.equal(settingsCalls, 1);
  assert.equal(page.data.permissionDenied, true);
});

test("result template displays save progress and explicit settings recovery", () => {
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  assert.match(template, /bindtap="saveVideo"/);
  assert.match(template, /downloadProgress/);
  assert.match(template, /bindtap="saveImage"/);
  assert.match(template, /bindtap="openAlbumSettings"/);
});

test("ready result exposes match player and rally scopes with seekable highlights", async () => {
  const calls = [];
  const page = loadPage({
    result: {
      async getResultTask() { return { status: "succeeded", result: {} }; },
      async loadResultResources() { return { videoPath: "wxfile://video", imagePaths: [] }; },
      async getAnalytics() {
        return {
          quality: { confidence: "high", explanation: "数据连续" },
          match: { rally_count: { value: 3, unit: "count", source: "detections", confidence: "high" } },
          players: { upper: { distance_m: { value: 42.5, unit: "m", source: "court", confidence: "high" } }, lower: {} },
          rallies: [{ id: "rally-1", index: 1, start_sec: 4, end_sec: 12, duration_sec: 8, players: { upper: {}, lower: {} } }],
        };
      },
      async getHighlights() { return { items: [{ id: "highlight-1", start_sec: 4, end_sec: 12, selected: true, reasons: ["持续 8 秒"] }] }; },
    },
    wx: { createVideoContext() { return { seek(value) { calls.push(["seek", value]); } }; } },
  });

  await page.onLoad({ task_id: "task-dashboard" });
  page.onReady();
  page.changeScope({ currentTarget: { dataset: { scope: "player" } } });
  page.selectPlayer({ currentTarget: { dataset: { player: "upper" } } });
  page.seekTo({ currentTarget: { dataset: { seconds: 4 } } });

  assert.equal(page.data.scope, "player");
  assert.equal(page.data.metricCards[0].value, 42.5);
  assert.equal(page.data.rallies.length, 1);
  assert.equal(page.data.highlights.length, 1);
  assert.deepEqual(calls, [["seek", 4]]);
});

test("selected lower player is labelled self and is selected before the opponent", async () => {
  const page = loadPage({
    result: {
      async getResultTask() { return { status: "succeeded", player_position: "lower", result: {} }; },
      async loadResultResources() { return { videoPath: "wxfile://video", imagePaths: [] }; },
      async getAnalytics() { return { match: {}, players: { upper: {}, lower: {} }, rallies: [] }; },
      async getHighlights() { return { items: [] }; },
    },
  });

  await page.onLoad({ task_id: "task-self-lower" });
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");
  assert.equal(page.data.selectedPlayer, "lower");
  assert.equal(page.data.playerLabels.lower, "自己");
  assert.equal(page.data.playerLabels.upper, "对手");
  assert.match(template, /wx:for="\{\{playerTabs\}\}"/);
  assert.match(template, /\{\{item\.label\}\}/);
  assert.doesNotMatch(template, /上半场球员|下半场球员/);
});

test("skipped player selection keeps neutral upper and lower labels", async () => {
  const page = loadPage({
    result: {
      async getResultTask() { return { status: "succeeded", player_position: "skip", result: {} }; },
      async loadResultResources() { return { videoPath: "wxfile://video", imagePaths: [] }; },
      async getAnalytics() { return { match: {}, players: { upper: {}, lower: {} }, rallies: [] }; },
      async getHighlights() { return { items: [] }; },
    },
  });

  await page.onLoad({ task_id: "task-skip" });
  assert.equal(page.data.myPosition, null);
  assert.equal(page.data.playerLabels.upper, "上方球员");
  assert.equal(page.data.playerLabels.lower, "下方球员");
});

test("highlight editor sends only the user overlay and refreshes displayed items", async () => {
  const calls = [];
  const page = loadPage({
    result: {
      async updateHighlight(taskId, highlightId, input) {
        calls.push([taskId, highlightId, input]);
        return { items: [{ id: highlightId, ...input, source: "user_edited" }] };
      },
    },
    wx: { showToast() {} },
  });
  page.setData({
    taskId: "task-edit",
    highlights: [{ id: "highlight-1", start_sec: 2, end_sec: 10, selected: true }],
  });
  page.editHighlight({ currentTarget: { dataset: { index: 0 } } });
  page.onHighlightField({ currentTarget: { dataset: { field: "title" } }, detail: { value: "我的高光" } });
  await page.saveHighlight();

  assert.equal(calls[0][0], "task-edit");
  assert.equal(calls[0][1], "highlight-1");
  assert.equal(calls[0][2].title, "我的高光");
  assert.equal(page.data.highlights[0].source, "user_edited");
  assert.equal(page.data.highlightEditorOpen, false);
});

test("highlight clip is generated privately before saving to the album", async () => {
  const calls = [];
  const page = loadPage({
    result: { async createHighlightClip(taskId, highlightId) { calls.push(["create", taskId, highlightId]); } },
    download: {
      async downloadTaskFile(input) { calls.push(["download", input.kind, input.resourceKey]); return "wxfile://clip"; },
      async saveVideoToAlbum(path) { calls.push(["save", path]); },
      isAlbumPermissionDenied() { return false; },
    },
    wx: { showToast() {} },
  });
  page.setData({ taskId: "task-clips", highlights: [{ id: "highlight-1" }] });

  await page.saveHighlightClip({ currentTarget: { dataset: { id: "highlight-1" } } });

  assert.deepEqual(calls, [
    ["create", "task-clips", "highlight-1"],
    ["download", "clips", "highlight-1"],
    ["save", "wxfile://clip"],
  ]);
  assert.equal(page.data.savingClipId, "");
});
