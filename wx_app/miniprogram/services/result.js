const { getApiBaseUrl } = require("./config");
const { request } = require("./http");
const { getAccessToken } = require("./token");

function wxDownloadFile(input) {
  return new Promise((resolve, reject) => wx.downloadFile({ ...input, success: resolve, fail: reject }));
}

function createResultClient({ request, downloadFile, getToken }) {
  function taskUrl(taskId) {
    return `${getApiBaseUrl()}/analysis/tasks/${taskId}`;
  }

  async function downloadResource(taskId, kind, index) {
    const token = getToken();
    const query = Number.isInteger(index) ? `?index=${index}` : "";
    const response = await downloadFile({
      url: `${taskUrl(taskId)}/files/${kind}${query}`,
      header: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.statusCode < 200 || response.statusCode >= 300 || !response.tempFilePath) {
      throw new Error("结果资源加载失败");
    }
    return response.tempFilePath;
  }

  return {
    getResultTask(taskId) {
      return request({ url: taskUrl(taskId), method: "GET" });
    },
    getAnalytics(taskId) {
      return request({ url: `${taskUrl(taskId)}/analytics`, method: "GET" });
    },
    getHighlights(taskId) {
      return request({ url: `${taskUrl(taskId)}/highlights`, method: "GET" });
    },
    updateHighlight(taskId, highlightId, data) {
      return request({
        url: `${taskUrl(taskId)}/highlights/${encodeURIComponent(highlightId)}`,
        method: "PUT",
        data,
      });
    },
    createHighlightClip(taskId, highlightId) {
      return request({ url: `${taskUrl(taskId)}/highlights/${encodeURIComponent(highlightId)}/clip`, method: "POST" });
    },
    createShare(taskId, data) {
      return request({ url: `${taskUrl(taskId)}/shares`, method: "POST", data });
    },
    async loadResultResources(taskId, descriptor = {}) {
      const videoPath = descriptor.video ? await downloadResource(taskId, "video") : "";
      const visualizations = Array.isArray(descriptor.visualizations)
        ? descriptor.visualizations
        : [];
      const imagePaths = await Promise.all(
        visualizations.map((_, index) => downloadResource(taskId, "visualization", index)),
      );
      return { videoPath, imagePaths };
    },
  };
}

const resultClient = createResultClient({ request, downloadFile: wxDownloadFile, getToken: getAccessToken });
module.exports = {
  createResultClient,
  getResultTask: resultClient.getResultTask,
  getAnalytics: resultClient.getAnalytics,
  getHighlights: resultClient.getHighlights,
  updateHighlight: resultClient.updateHighlight,
  createHighlightClip: resultClient.createHighlightClip,
  createShare: resultClient.createShare,
  loadResultResources: resultClient.loadResultResources,
};
