const { API_BASE_URL } = require("./config");
const { request } = require("./http");
const { getAccessToken } = require("./token");

function createProfileClient(dependencies) {
  return {
    getCurrentProfile() {
      return dependencies.request({ url: `${API_BASE_URL}/auth/me`, method: "GET" });
    },
    saveProfile({ nickname, avatarUrl }) {
      return dependencies.request({ url: `${API_BASE_URL}/auth/me`, method: "PUT", data: { nickname, avatar_url: avatarUrl } });
    },
  };
}

function uploadAvatar(filePath) {
  const token = getAccessToken();
  return new Promise((resolve, reject) => wx.uploadFile({
    url: `${API_BASE_URL}/auth/me/avatar`, filePath, name: "avatar", header: token ? { Authorization: `Bearer ${token}` } : {},
    success: (response) => {
      let payload;
      try { payload = JSON.parse(response.data); } catch { reject(new Error("头像上传响应无效")); return; }
      if (response.statusCode < 200 || response.statusCode >= 300) { reject(new Error(payload.detail || "头像上传失败")); return; }
      resolve(payload.avatar_url);
    },
    fail: reject,
  }));
}

const profileClient = createProfileClient({ request });
module.exports = {
  createProfileClient,
  getCurrentProfile: profileClient.getCurrentProfile,
  saveProfile: profileClient.saveProfile,
  uploadAvatar,
};
