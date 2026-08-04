const { getApiBaseUrl } = require("./config");
const { getAccessToken } = require("./token");

function asPromise(invoke) {
  return new Promise((resolve, reject) => invoke({ success: resolve, fail: reject }));
}

function isAlbumPermissionDenied(error) {
  const text = String((error && (error.errMsg || error.message)) || "").toLowerCase();
  return text.includes("auth deny") || text.includes("authorize:fail") || text.includes("permission denied");
}

function createDownloadService({
  getToken,
  downloadFile,
  saveVideo,
  saveImage,
  openSetting,
}) {
  function downloadTaskFile({ taskId, kind, index, resourceKey, onProgress = () => {} }) {
    const token = getToken();
    if (!token) return Promise.reject(new Error("请先登录后下载"));
    const query = Number.isInteger(index) ? `?index=${index}` : "";
    const resourcePath = kind === "clips" && resourceKey
      ? `${kind}/${encodeURIComponent(resourceKey)}`
      : kind;
    onProgress(0);
    return new Promise((resolve, reject) => {
      const task = downloadFile({
        url: `${getApiBaseUrl()}/analysis/tasks/${taskId}/files/${resourcePath}${query}`,
        header: { Authorization: `Bearer ${token}` },
        success(response) {
          if (response.statusCode < 200 || response.statusCode >= 300 || !response.tempFilePath) {
            reject(new Error(`结果文件下载失败（${response.statusCode || "未知状态"}）`));
            return;
          }
          onProgress(100);
          resolve(response.tempFilePath);
        },
        fail(error) {
          reject(new Error((error && error.errMsg) || "结果文件下载失败"));
        },
      });
      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((event) => onProgress(Math.max(0, Math.min(100, Number(event.progress) || 0))));
      }
    });
  }

  return {
    downloadTaskFile,
    saveVideoToAlbum(filePath) {
      return asPromise((callbacks) => saveVideo({ filePath, ...callbacks }));
    },
    saveImageToAlbum(filePath) {
      return asPromise((callbacks) => saveImage({ filePath, ...callbacks }));
    },
    async openAlbumSettings() {
      const response = await asPromise((callbacks) => openSetting(callbacks));
      return Boolean(response.authSetting && response.authSetting["scope.writePhotosAlbum"]);
    },
    isAlbumPermissionDenied,
  };
}

const service = createDownloadService({
  getToken: getAccessToken,
  downloadFile: (options) => wx.downloadFile(options),
  saveVideo: (options) => wx.saveVideoToPhotosAlbum(options),
  saveImage: (options) => wx.saveImageToPhotosAlbum(options),
  openSetting: (options) => wx.openSetting(options),
});

module.exports = { createDownloadService, isAlbumPermissionDenied, ...service };
