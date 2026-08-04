const assert = require("node:assert/strict");
const test = require("node:test");

global.wx = { downloadFile() {}, getStorageSync() { return "https://api.example.com/api"; } };
const { createResultClient } = require("../../miniprogram/services/result");

test("result client reads structured data and saves a user highlight overlay", async () => {
  const calls = [];
  const client = createResultClient({
    async request(input) { calls.push(input); return { items: [] }; },
    async downloadFile() { return { statusCode: 200, tempFilePath: "wxfile://result" }; },
    getToken() { return "token"; },
  });

  await client.getAnalytics("task-1");
  await client.getHighlights("task-1");
  await client.updateHighlight("task-1", "highlight-1", {
    start_sec: 2,
    end_sec: 8,
    selected: true,
    title: "关键回合",
  });
  await client.createHighlightClip("task-1", "highlight-1");
  await client.createShare("task-1", { resource_kind: "report", expires_in_hours: 24 });

  assert.deepEqual(calls.map((item) => [item.method, item.url]), [
    ["GET", "https://api.example.com/api/analysis/tasks/task-1/analytics"],
    ["GET", "https://api.example.com/api/analysis/tasks/task-1/highlights"],
    ["PUT", "https://api.example.com/api/analysis/tasks/task-1/highlights/highlight-1"],
    ["POST", "https://api.example.com/api/analysis/tasks/task-1/highlights/highlight-1/clip"],
    ["POST", "https://api.example.com/api/analysis/tasks/task-1/shares"],
  ]);
  assert.equal(calls[2].data.title, "关键回合");
});
