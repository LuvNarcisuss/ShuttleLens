const assert = require("node:assert/strict");
const test = require("node:test");

const { createDownloadService, isAlbumPermissionDenied } = require("../../miniprogram/services/download");

test("authenticated download reports progress and resolves the temporary file", async () => {
  const calls = [];
  const service = createDownloadService({
    getToken: () => "token-1",
    downloadFile(options) {
      calls.push(options);
      queueMicrotask(() => progressHandler({ progress: 46 }));
      queueMicrotask(() => options.success({ statusCode: 200, tempFilePath: "wxfile://video" }));
      return { onProgressUpdate(handler) { progressHandler = handler; } };
    },
  });
  let progressHandler;
  const progress = [];

  const path = await service.downloadTaskFile({ taskId: "task-1", kind: "video", onProgress(value) { progress.push(value); } });

  assert.equal(path, "wxfile://video");
  assert.match(calls[0].url, /\/analysis\/tasks\/task-1\/files\/video$/);
  assert.deepEqual(calls[0].header, { Authorization: "Bearer token-1" });
  assert.deepEqual(progress, [0, 46, 100]);
});

test("visualization download includes its index and rejects HTTP failures", async () => {
  const service = createDownloadService({
    getToken: () => "token-2",
    downloadFile(options) {
      assert.match(options.url, /visualization\?index=2$/);
      queueMicrotask(() => options.success({ statusCode: 403 }));
      return { onProgressUpdate() {} };
    },
  });

  await assert.rejects(
    service.downloadTaskFile({ taskId: "task-2", kind: "visualization", index: 2 }),
    /下载失败/,
  );
});

test("private highlight clip download encodes its resource key in the path", async () => {
  let requestedUrl = "";
  const service = createDownloadService({
    getToken: () => "token-1",
    downloadFile(input) {
      requestedUrl = input.url;
      input.success({ statusCode: 200, tempFilePath: "wxfile://clip" });
      return { onProgressUpdate() {} };
    },
    saveVideo() {}, saveImage() {}, openSetting() {},
  });
  await service.downloadTaskFile({ taskId: "task-1", kind: "clips", resourceKey: "high light/1" });
  assert.match(requestedUrl, /\/files\/clips\/high%20light%2F1$/);
});

test("download rejects network failures without attempting an album save", async () => {
  const service = createDownloadService({
    getToken: () => "token-3",
    downloadFile(options) {
      queueMicrotask(() => options.fail({ errMsg: "downloadFile:fail network timeout" }));
      return { onProgressUpdate() {} };
    },
  });

  await assert.rejects(
    service.downloadTaskFile({ taskId: "task-3", kind: "video" }),
    /network timeout/,
  );
});

test("save helpers use the matching album API without opening settings", async () => {
  const calls = [];
  const service = createDownloadService({
    getToken: () => "token",
    downloadFile() { throw new Error("unused"); },
    saveVideo(options) { calls.push(["video", options.filePath]); options.success(); },
    saveImage(options) { calls.push(["image", options.filePath]); options.success(); },
    openSetting() { calls.push(["settings"]); },
  });

  await service.saveVideoToAlbum("wxfile://v");
  await service.saveImageToAlbum("wxfile://i");

  assert.deepEqual(calls, [["video", "wxfile://v"], ["image", "wxfile://i"]]);
});

test("permission helper recognizes album authorization rejection", () => {
  assert.equal(isAlbumPermissionDenied({ errMsg: "saveVideoToPhotosAlbum:fail auth deny" }), true);
  assert.equal(isAlbumPermissionDenied({ errMsg: "saveImageToPhotosAlbum:fail cancel" }), false);
});
