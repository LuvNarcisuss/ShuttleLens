const { getApiBaseUrl } = require("./config");
const { request } = require("./http");
const { getAccessToken } = require("./token");

function wxUploadFile(input) {
  return new Promise((resolve, reject) => wx.uploadFile({ ...input, success: resolve, fail: reject }));
}

function getUploadError(payload, fallback) {
  return payload && (payload.detail || payload.message) ? payload.detail || payload.message : fallback;
}

function createAnalysisClient({ request, uploadFile }) {
  function taskUrl(taskId) {
    return `${getApiBaseUrl()}/analysis/tasks${taskId ? `/${taskId}` : ""}`;
  }

  function careerUrl() {
    return `${getApiBaseUrl()}/analysis/career/stats`;
  }

  async function upload(taskId, filePath, type) {
    let response;
    try {
      const token = getAccessToken();
      response = await uploadFile({
        url: `${taskUrl(taskId)}/uploads/${type}`,
        filePath,
        name: "file",
        header: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error("上传失败，请稍后重试");
    }

    let payload;
    try {
      payload = JSON.parse(response.data);
    } catch {
      throw new Error("上传响应无效");
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(getUploadError(payload, "上传失败，请稍后重试"));
    }
    return payload;
  }

  return {
    createTask(options = {}) {
      return request({ url: taskUrl(), method: "POST", data: options });
    },
    uploadVideo(taskId, filePath) {
      return upload(taskId, filePath, "video");
    },
    uploadTemplate(taskId, filePath) {
      return upload(taskId, filePath, "template");
    },
    detectCourt(taskId) {
      return request({ url: `${taskUrl(taskId)}/detect-court`, method: "POST" });
    },
    saveCorners(taskId, corners) {
      return request({ url: `${taskUrl(taskId)}/corners`, method: "PUT", data: { corners } });
    },
    runTask(taskId, playerPosition, matchResult) {
      const data = {};
      if (playerPosition) data.player_position = playerPosition;
      if (playerPosition && playerPosition !== 'skip' && matchResult) {
        data.match_result = matchResult;
      }
      return request({ url: `${taskUrl(taskId)}/run`, method: "POST", data });
    },
    getTask(taskId) {
      return request({ url: taskUrl(taskId), method: "GET" });
    },
    getCalibrationFrames(taskId) {
      return request({ url: `${taskUrl(taskId)}/calibration-frames`, method: "GET" });
    },
    listTasks({ status = "", cursor = "", limit = 20 } = {}) {
      const query = [];
      if (status) query.push(`status=${encodeURIComponent(status)}`);
      if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);
      query.push(`limit=${encodeURIComponent(limit)}`);
      return request({ url: `${taskUrl()}?${query.join("&")}`, method: "GET" });
    },
    renameTask(taskId, name) {
      return request({ url: taskUrl(taskId), method: "PATCH", data: { name } });
    },
    cancelTask(taskId) {
      return request({ url: `${taskUrl(taskId)}/cancel`, method: "POST" });
    },
    retryTask(taskId) {
      return request({ url: `${taskUrl(taskId)}/retry`, method: "POST" });
    },
    reanalyzeTask(taskId) {
      return request({ url: `${taskUrl(taskId)}/reanalyze`, method: "POST" });
    },
    deleteTask(taskId) {
      return request({ url: taskUrl(taskId), method: "DELETE" });
    },
    getCareerStats(dateRange = 'all') {
      return request({ url: `${careerUrl()}?date_range=${encodeURIComponent(dateRange)}`, method: "GET" });
    },
  };
}

const analysisClient = createAnalysisClient({ request, uploadFile: wxUploadFile });

module.exports = {
  createAnalysisClient,
  createTask: analysisClient.createTask,
  uploadVideo: analysisClient.uploadVideo,
  uploadTemplate: analysisClient.uploadTemplate,
  detectCourt: analysisClient.detectCourt,
  saveCorners: analysisClient.saveCorners,
  runTask: analysisClient.runTask,
  getTask: analysisClient.getTask,
  getCalibrationFrames: analysisClient.getCalibrationFrames,
  listTasks: analysisClient.listTasks,
  renameTask: analysisClient.renameTask,
  cancelTask: analysisClient.cancelTask,
  retryTask: analysisClient.retryTask,
  reanalyzeTask: analysisClient.reanalyzeTask,
  deleteTask: analysisClient.deleteTask,
  getCareerStats: analysisClient.getCareerStats,
};
