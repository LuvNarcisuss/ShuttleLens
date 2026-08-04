const { getAccessToken } = require("./token");
class BusinessError extends Error {
  constructor(code, message, statusCode) {
    super(message); this.code = code; this.statusCode = statusCode;
  }
}
function toBusinessError(response) {
  const payload = response.data || {};
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : payload;
  return new BusinessError(detail.code || "REQUEST_FAILED", detail.message || "请求失败，请稍后重试", response.statusCode);
}
function createHttpClient(dependencies) {
  async function request(input, retried = false) {
    const token = dependencies.getToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await dependencies.send({ ...input, headers });
    if (response.statusCode === 401 && !retried && token) {
      const currentToken = dependencies.getToken();
      if (currentToken) {
        if (currentToken === token) await dependencies.relogin();
        return request(input, true);
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) { throw toBusinessError(response); }
    return response.data;
  }
  return { request };
}
function wxSend(request) {
  return new Promise((resolve, reject) => wx.request({ url: request.url, method: request.method || "GET", data: request.data, header: request.headers, success: resolve, fail: reject }));
}
let reloginHandler = async () => {};
function setReloginHandler(handler) { reloginHandler = handler; }
const http = createHttpClient({ getToken: getAccessToken, relogin: () => reloginHandler(), send: wxSend });
module.exports = { BusinessError, createHttpClient, request: http.request, setReloginHandler };
