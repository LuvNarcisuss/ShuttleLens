const TOKEN_KEY = "access_token";
function getAccessToken() { return wx.getStorageSync(TOKEN_KEY) || null; }
function saveAccessToken(token) { wx.setStorageSync(TOKEN_KEY, token); }
function clearAccessToken() { wx.removeStorageSync(TOKEN_KEY); }
module.exports = { clearAccessToken, getAccessToken, saveAccessToken };
