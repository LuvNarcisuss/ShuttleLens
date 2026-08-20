const TOKEN_KEY = "access_token";
const AUTH_METHOD_KEY = "auth_method";
function getAccessToken() { return wx.getStorageSync(TOKEN_KEY) || null; }
function getAuthMethod() {
  const method = wx.getStorageSync(AUTH_METHOD_KEY);
  return method === "wechat" || method === "account" ? method : null;
}
function saveAccessToken(token, authMethod) {
  wx.setStorageSync(TOKEN_KEY, token);
  wx.setStorageSync(AUTH_METHOD_KEY, authMethod);
}
function clearAccessToken() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(AUTH_METHOD_KEY);
}
module.exports = { clearAccessToken, getAccessToken, getAuthMethod, saveAccessToken };
