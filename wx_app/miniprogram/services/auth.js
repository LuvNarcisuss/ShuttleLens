const { request, setReloginHandler } = require("./http");
const { clearAccessToken, getAccessToken, getAuthMethod, saveAccessToken } = require("./token");
const { API_BASE_URL } = require("./config");

function getWechatLoginCode() {
  return new Promise((resolve, reject) => wx.login({
    success({ code }) {
      if (code) resolve(code);
      else reject(new Error("微信未返回登录码"));
    },
    fail: reject,
  }));
}

async function ensureLogin() {
  const loginCode = await getWechatLoginCode();
  const response = await request({
    url: `${API_BASE_URL}/auth/wechat/login`,
    method: "POST",
    data: { login_code: loginCode },
  });
  saveAccessToken(response.access_token, "wechat");
  return response;
}

async function loginByAccount(accountNumber, password) {
  const response = await request({
    url: `${API_BASE_URL}/auth/account/login`,
    method: "POST",
    data: { account_number: accountNumber, password },
  });
  saveAccessToken(response.access_token, "account");
  return response;
}

function setPassword(password) {
  return request({
    url: `${API_BASE_URL}/auth/account/password`,
    method: "POST",
    data: { password },
  });
}

function bindPhone(phoneCode) {
  return request({
    url: `${API_BASE_URL}/auth/wechat/phone`,
    method: "POST",
    data: { phone_code: phoneCode },
  });
}

function unbindPhone() {
  return request({
    url: `${API_BASE_URL}/auth/wechat/phone`,
    method: "DELETE",
  });
}

function unbindWechat() {
  return request({
    url: `${API_BASE_URL}/auth/wechat/unbind`,
    method: "POST",
  });
}

async function bindWechat() {
  const loginCode = await getWechatLoginCode();
  return request({
    url: `${API_BASE_URL}/auth/wechat/bind`,
    method: "POST",
    data: { login_code: loginCode },
  });
}

function deactivateAccount() {
  return request({
    url: `${API_BASE_URL}/auth/deactivate`,
    method: "POST",
  });
}

function restoreSession() {
  if (!getAccessToken()) return Promise.resolve(null);
  return request({ url: `${API_BASE_URL}/auth/me`, method: "GET" });
}

function logout() {
  clearAccessToken();
  if (typeof wx.removeStorageSync === "function") {
    // 清除用户相关缓存
    wx.removeStorageSync("current_user");
    wx.removeStorageSync("preview_task_id");
    // 清除分析相关缓存
    wx.removeStorageSync("last_analysis_result");
    wx.removeStorageSync("analysis_cache");
    wx.removeStorageSync("tasks_cache");
    wx.removeStorageSync("career_stats_cache");
  }
}

async function relogin() {
  if (getAuthMethod() !== "account") return ensureLogin();

  logout();
  if (typeof wx.reLaunch === "function") {
    wx.reLaunch({ url: "/pages/login/index" });
  }
  const error = new Error("登录已失效，请使用账号密码重新登录");
  error.code = "ACCOUNT_RELOGIN_REQUIRED";
  throw error;
}

setReloginHandler(relogin);

module.exports = {
  bindPhone,
  unbindPhone,
  unbindWechat,
  bindWechat,
  deactivateAccount,
  ensureLogin,
  loginByAccount,
  setPassword,
  logout,
  restoreSession,
};
