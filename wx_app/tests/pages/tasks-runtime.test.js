const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pageDirectory = resolve(__dirname, "../../miniprogram/pages/tasks");

function loadPage({ analysis = {}, wx = {}, setInterval = () => 1, clearInterval = () => {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(path) {
      if (path === "../../services/analysis") return analysis;
      if (path === "../../services/download") return {};
      if (path === "../../services/token") return { getAccessToken: () => "token-1" };
      throw new Error(`Unexpected dependency: ${path}`);
    },
    Page(value) { definition = value; },
    wx,
    setInterval,
    clearInterval,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}

test("tasks page refreshes immediately on show and stops polling while hidden", async () => {
  const listCalls = [];
  const timers = [];
  const cleared = [];
  const page = loadPage({
    analysis: {
      async listTasks(input) {
        listCalls.push(input);
        return {
          items: [{ id: "queued-1", name: "训练赛", status: "queued", stage: "queued", progress: 10 }],
          total: 1,
          next_cursor: null,
        };
      },
    },
    setInterval(callback, delay) { timers.push([callback, delay]); return 7; },
    clearInterval(id) { cleared.push(id); },
  });

  await page.onShow();
  assert.deepEqual(JSON.parse(JSON.stringify(listCalls)), [{ status: "", cursor: "", limit: 20 }]);
  assert.equal(timers[0][1], 5000);
  assert.equal(page.data.tasks[0].name, "训练赛");
  page.onHide();
  assert.deepEqual(cleared, [7]);
  await page.onShow();
  assert.equal(listCalls.length, 2);
});

test("tasks page keeps cursor pagination stable and pull-down refresh resets it", async () => {
  const calls = [];
  let stopped = 0;
  const responses = [
    { items: [{ id: "a", status: "succeeded" }], total: 2, next_cursor: "cursor-1" },
    { items: [{ id: "b", status: "failed" }], total: 2, next_cursor: null },
    { items: [{ id: "c", status: "succeeded" }], total: 1, next_cursor: null },
  ];
  const page = loadPage({
    analysis: {
      async listTasks(input) { calls.push(input); return responses.shift(); },
    },
    wx: { stopPullDownRefresh() { stopped += 1; } },
  });

  await page.refreshTasks();
  await page.loadNextPage();
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.tasks.map((item) => item.id))), ["a", "b"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { status: "", cursor: "cursor-1", limit: 20 });
  await page.onPullDownRefresh();
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.tasks.map((item) => item.id))), ["c"]);
  assert.equal(page.data.nextCursor, "");
  assert.equal(stopped, 1);
});

test("tasks page maps recorded match results and leaves missing results hidden", async () => {
  const page = loadPage({
    analysis: {
      async listTasks() {
        return {
          items: [
            { id: "win-1", name: "胜场", status: "succeeded", stage: "completed", progress: 100, match_result: "win", video_metadata: {} },
            { id: "loss-1", name: "负场", status: "succeeded", stage: "completed", progress: 100, match_result: "loss", video_metadata: {} },
            { id: "draw-1", name: "平局", status: "succeeded", stage: "completed", progress: 100, match_result: "draw", video_metadata: {} },
            { id: "legacy-1", name: "历史任务", status: "succeeded", stage: "completed", progress: 100, match_result: null, video_metadata: {} },
          ],
          total: 4,
          next_cursor: null,
        };
      },
    },
  });

  await page.refreshTasks();

  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.tasks.map((item) => item.matchResultLabel))),
    ["胜", "负", "平", ""],
  );
});

test("tasks page does not restart polling when hidden during an in-flight refresh", async () => {
  let resolveList;
  const timers = [];
  const page = loadPage({
    analysis: {
      listTasks() { return new Promise((resolve) => { resolveList = resolve; }); },
    },
    setInterval(callback, delay) { timers.push([callback, delay]); return 9; },
  });

  const showing = page.onShow();
  page.onHide();
  resolveList({ items: [{ id: "queued", status: "queued" }], total: 1 });
  await showing;

  assert.equal(timers.length, 0);
  assert.deepEqual(page.data.tasks, []);
});
