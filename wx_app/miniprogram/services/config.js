const API_BASE_URL = "http://127.0.0.1:8000/api";

function getApiBaseUrl() {
  const configuredUrl = typeof wx === "undefined" ? "" : wx.getStorageSync("api_base_url");
  return configuredUrl || API_BASE_URL;
}

module.exports = { API_BASE_URL, getApiBaseUrl };
