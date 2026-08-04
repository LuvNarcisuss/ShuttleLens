const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/analyze");

function loadPage({ analysis = {}, download = {}, wx = {}, setInterval = () => 1, clearInterval = () => {} } = {}) {
  let definition;
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  vm.runInNewContext(source, {
    require(request) {
      if (request === "../../services/analysis") return analysis;
      if (request === "../../services/download") return download;
      if (request === "../../utils/calibration") return require("../../miniprogram/utils/calibration");
      if (request === "../../services/config") return { getApiBaseUrl: () => "https://api.example.com/api" };
      if (request === "../../services/token") return { getAccessToken: () => "token-1" };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    Page(value) { definition = value; },
    wx,
    setInterval,
    clearInterval,
    console,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
  return page;
}

test("analyze page exposes TaskOptions defaults and native media selection", async () => {
  const chosen = [];
  const page = loadPage({
    wx: {
      chooseMedia({ success }) { chosen.push("video"); success({ tempFiles: [{ tempFilePath: "match.mp4" }] }); },
      chooseImage({ success }) { chosen.push("template"); success({ tempFilePaths: ["court.png"] }); },
    },
  });

  assert.deepEqual(page.data.options, {
    pose_family: "yolo-pose",
    pose_mode: "balanced",
    language: "zh",
    audio: true,
    show_skeletons: true,
    show_player_trajectories: true,
    show_court_trajectory: true,
    show_shuttlecock_trajectory: true,
    show_player_stats: true,
    show_pose_roi: true,
    visualize_positions: true,
    yolo_pose_model: "weights/yolo11n-pose.pt",
    ball_model: "weights/yolo11s-ball.pt",
  });
  await page.chooseVideo();
  await page.chooseTemplate();
  assert.deepEqual(chosen, ["video", "template"]);
  assert.equal(page.data.videoPath, "match.mp4");
  assert.equal(page.data.templatePath, "court.png");
});

test("court detection uses the video candidate frame without a separate template upload", async () => {
  const calls = [];
  const corners = [[10, 10], [90, 10], [90, 60], [10, 60]];
  const page = loadPage({
    analysis: {
      async createTask() { calls.push("create"); return { id: "task-1" }; },
      async uploadVideo() { calls.push("video"); },
      async uploadTemplate() { calls.push("template"); },
      async getCalibrationFrames() { calls.push("frames"); return { items: [{ index: 0, width: 1280, height: 720 }] }; },
      async detectCourt() { calls.push("detect"); return { corners }; },
      async saveCorners(taskId, value) { calls.push(["save", taskId, value]); },
    },
    download: { async downloadTaskFile() { calls.push("download"); return "wxfile://candidate"; } },
    wx: { showToast() {}, navigateTo(input) { calls.push(["result", input.url]); } },
  });
  page.setData({ videoPath: "match.mp4" });

  await page.detectCourt();

  assert.deepEqual(calls.slice(0, 5), ["create", "video", "frames", "download", "detect"]);
  assert.deepEqual(calls[5], ["save", "task-1", corners]);
  assert.equal(calls.includes("template"), false);
  assert.equal(page.data.templatePath, "wxfile://candidate");
  assert.deepEqual(page.data.corners, corners);
  assert.equal(page.data.manualMode, false);
});

test("missing automatic corners enters manual mode and only four points can be saved", async () => {
  const saved = [];
  const page = loadPage({
    analysis: {
      async createTask() { return { id: "task-2" }; },
      async uploadVideo() {},
      async uploadTemplate() {},
      async getCalibrationFrames() { return { items: [{ index: 0, width: 1280, height: 720 }] }; },
      async detectCourt() { return { corners: [] }; },
      async saveCorners(taskId, corners) { saved.push([taskId, corners]); },
    },
    download: { async downloadTaskFile() { return "wxfile://candidate"; } },
    wx: { showToast() {} },
  });
  page.setData({ videoPath: "match.mp4" });
  await page.detectCourt();

  assert.equal(page.data.manualMode, true);
  await page.saveManualCorners();
  assert.equal(saved.length, 0);
  for (const point of [[10, 10], [90, 10], [90, 60], [10, 60]]) {
    page.addCorner({ detail: { x: point[0], y: point[1] } });
  }
  await page.saveManualCorners();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1].length, 4);
});

test("video selection exposes metadata and a processing estimate before upload", async () => {
  const page = loadPage({
    wx: {
      chooseMedia({ success }) {
        success({
          tempFiles: [{
            tempFilePath: "match.mp4",
            size: 25 * 1024 * 1024,
            duration: 90,
            width: 1920,
            height: 1080,
          }],
        });
      },
    },
  });

  await page.chooseVideo();

  assert.equal(page.data.videoInfo.name, "match.mp4");
  assert.equal(page.data.videoInfo.sizeLabel, "25.0 MB");
  assert.equal(page.data.videoInfo.durationLabel, "1 分 30 秒");
  assert.equal(page.data.videoInfo.resolutionLabel, "1920 × 1080");
  assert.match(page.data.estimateLabel, /预计/);
});

test("manual corner taps map the displayed template back to original image pixels", () => {
  const page = loadPage({
    wx: {
      createSelectorQuery() {
        return {
          select() { return this; },
          boundingClientRect(callback) {
            callback({ left: 10, top: 20, width: 100, height: 50 });
            return this;
          },
          exec() {},
        };
      },
    },
  });
  page.setData({ manualMode: true });
  page.onTemplateLoad({ detail: { width: 1000, height: 500 } });

  page.addCorner({ changedTouches: [{ pageX: 60, pageY: 45 }] });

  assert.deepEqual(JSON.parse(JSON.stringify(page.data.corners)), [[500, 250]]);
});

test("analysis saves corners, starts polling every two seconds and clears timers", async () => {
  const calls = [];
  const cleared = [];
  let poll;
  const page = loadPage({
    analysis: {
      async saveCorners() { calls.push("save"); },
      async runTask() { calls.push("run"); },
      async getTask() {
        calls.push("get");
        return { id: "task-3", status: "succeeded", progress: 100, result: {}, error_message: null };
      },
    },
    wx: { showToast() {}, navigateTo(input) { calls.push(["result", input.url]); } },
    setInterval(callback, delay) { poll = callback; calls.push(["interval", delay]); return 7; },
    clearInterval(id) { cleared.push(id); },
  });
  page.setData({ taskId: "task-3", corners: [[0, 0], [1, 0], [1, 1], [0, 1]], playerSelection: "upper", matchResult: "win" });

  await page.startAnalysis();
  assert.deepEqual(calls, ["save", "run", ["interval", 2000]]);
  await poll();
  assert.equal(page.data.taskStatus, "succeeded");
  assert.equal(page.data.progress, 100);
  assert.deepEqual(cleared, [7]);
  assert.deepEqual(calls.at(-1), ["result", "/pages/result/index?task_id=task-3"]);

  page.pollTimer = 8;
  page.onHide();
  page.pollTimer = 9;
  page.onUnload();
  assert.deepEqual(cleared, [7, 8, 9]);
});

test("created draft tasks remain editable so analysis can be started", async () => {
  const page = loadPage();

  await page.applyTask({
    id: "task-draft",
    status: "created",
    progress: 0,
    error_message: null,
    recovery_hint: null,
  });

  assert.equal(page.data.taskStatus, "created");
  assert.equal(page.data.isRunning, false);
});

test("analysis page delegates succeeded tasks to the independent result page", () => {
  const source = readFileSync(resolve(pageDirectory, "index.js"), "utf8");
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");

  assert.doesNotMatch(source, /wx\.downloadFile|preview_task_id|loadResultAssets/);
  assert.match(source, /\/pages\/result\/index\?task_id=/);
  assert.doesNotMatch(template, /input_video_path|template_path|result\.video|result\.visualizations/);
  assert.match(template, /选择比赛视频/);
  assert.match(template, /选择球场模板/);
  assert.match(template, /检测球场/);
  assert.match(template, /开始分析/);
});

test("analysis template requires an explicit player decision before step five starts", () => {
  const template = readFileSync(resolve(pageDirectory, "index.wxml"), "utf8");

  assert.match(template, /<text class="step step-index">04<\/text><text>确定球员<\/text>/);
  assert.match(template, /data-position="upper"[^>]*>上方球员是我/s);
  assert.match(template, /data-position="lower"[^>]*>下方球员是我/s);
  assert.match(template, /data-position="skip"[^>]*>跳过/s);
  assert.match(template, /wx:if="\{\{playerSelection && playerSelection !== 'skip'\}\}"/);
  assert.match(template, /data-result="win"[^>]*>胜/s);
  assert.match(template, /data-result="loss"[^>]*>负/s);
  assert.match(template, /data-result="draw"[^>]*>平/s);
  assert.match(template, /<text class="step step-index">05<\/text><text>开始分析<\/text>/);
  assert.match(template, /disabled="\{\{isRunning \|\| corners\.length !== 4 \|\| !playerSelection \|\| \(playerSelection !== 'skip' && !matchResult\)\}\}"/);
});
