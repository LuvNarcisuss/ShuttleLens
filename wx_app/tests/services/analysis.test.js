const assert = require("node:assert/strict");
const test = require("node:test");

let storedBaseUrl = "";

global.wx = {
  getStorageSync(key) {
    if (key === "access_token") return "saved-token";
    if (key === "api_base_url") return storedBaseUrl;
    return "";
  },
};

const config = require("../../miniprogram/services/config");
const { createAnalysisClient } = require("../../miniprogram/services/analysis");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

test("analysis service exports the client factory and dynamic base URL accessor", () => {
  assert.equal(typeof config.getApiBaseUrl, "function");
  assert.equal(existsSync(resolve(__dirname, "../../miniprogram/services/analysis.js")), true);
});

test("getApiBaseUrl uses the Mini Program storage override when available", () => {
  storedBaseUrl = "https://api.example.com/api";
  try {
    assert.equal(config.getApiBaseUrl(), storedBaseUrl);
  } finally {
    storedBaseUrl = "";
  }
});

test("analysis client sends each task action to the matching API endpoint", async () => {
  const requests = [];
  const client = createAnalysisClient({
    request: async (input) => {
      requests.push(input);
      return input;
    },
    uploadFile: async () => ({ statusCode: 200, data: "{}" }),
  });

  assert.equal(typeof client.createTask, "function");
  if (typeof client.createTask !== "function") return;

  await client.createTask({ pose_mode: "lightweight" });
  await client.detectCourt("task-1");
  await client.saveCorners("task-1", [[0, 0], [1, 0], [1, 1], [0, 1]]);
  await client.runTask("task-1", "lower", "win");
  await client.getTask("task-1");
  await client.getCalibrationFrames("task-1");
  await client.listTasks({ status: "failed", cursor: "cursor-1", limit: 10 });
  await client.renameTask("task-1", "周三训练赛");
  await client.cancelTask("task-1");
  await client.retryTask("task-1");
  await client.reanalyzeTask("task-1");
  await client.deleteTask("task-1");

  assert.deepEqual(requests, [
    { url: "http://127.0.0.1:8000/api/analysis/tasks", method: "POST", data: { pose_mode: "lightweight" } },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/detect-court", method: "POST" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/corners", method: "PUT", data: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]] } },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/run", method: "POST", data: { player_position: "lower", match_result: "win" } },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1", method: "GET" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/calibration-frames", method: "GET" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks?status=failed&cursor=cursor-1&limit=10", method: "GET" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1", method: "PATCH", data: { name: "周三训练赛" } },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/cancel", method: "POST" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/retry", method: "POST" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/reanalyze", method: "POST" },
    { url: "http://127.0.0.1:8000/api/analysis/tasks/task-1", method: "DELETE" },
  ]);
});

test("analysis client uploads one file under file with the bearer token and parses JSON", async () => {
  const uploads = [];
  const client = createAnalysisClient({
    request: async () => ({}),
    uploadFile: async (input) => {
      uploads.push(input);
      return { statusCode: 200, data: '{"status":"uploaded"}' };
    },
  });

  assert.equal(typeof client.uploadVideo, "function");
  if (typeof client.uploadVideo !== "function") return;

  assert.deepEqual(await client.uploadVideo("task-1", "/tmp/match.mp4"), { status: "uploaded" });
  assert.deepEqual(await client.uploadTemplate("task-1", "/tmp/court.png"), { status: "uploaded" });
  assert.deepEqual(uploads, [
    {
      url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/uploads/video",
      filePath: "/tmp/match.mp4",
      name: "file",
      header: { Authorization: "Bearer saved-token" },
    },
    {
      url: "http://127.0.0.1:8000/api/analysis/tasks/task-1/uploads/template",
      filePath: "/tmp/court.png",
      name: "file",
      header: { Authorization: "Bearer saved-token" },
    },
  ]);
});

test("analysis client surfaces upload HTTP failures as Errors", async () => {
  const client = createAnalysisClient({
    request: async () => ({}),
    uploadFile: async () => ({ statusCode: 422, data: '{"detail":"invalid video"}' }),
  });

  assert.equal(typeof client.uploadVideo, "function");
  if (typeof client.uploadVideo !== "function") return;

  await assert.rejects(() => client.uploadVideo("task-1", "/tmp/match.mp4"), /invalid video/);
});
