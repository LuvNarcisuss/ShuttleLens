const assert = require("node:assert/strict");
const test = require("node:test");
const { BusinessError, createHttpClient } = require("../../miniprogram/services/http");
test("request attaches the saved bearer token", async () => {
  let receivedHeaders;
  const client = createHttpClient({ getToken: () => "saved-token", relogin: async () => {}, send: async (request) => { receivedHeaders = request.headers; return { statusCode: 200, data: { status: "ok" } }; } });
  assert.deepEqual(await client.request({ url: "/healthz" }), { status: "ok" });
  assert.equal(receivedHeaders.Authorization, "Bearer saved-token");
});
test("request refreshes login once after a 401", async () => {
  let attempts = 0; let relogins = 0;
  const client = createHttpClient({ getToken: () => "old-token", relogin: async () => { relogins += 1; }, send: async () => { attempts += 1; return attempts === 1 ? { statusCode: 401, data: { message: "expired" } } : { statusCode: 200, data: { status: "ok" } }; } });
  assert.deepEqual(await client.request({ url: "/healthz" }), { status: "ok" });
  assert.equal(relogins, 1); assert.equal(attempts, 2);
});
test("request does not relogin after a 401 when it started without a token", async () => {
  let attempts = 0;
  let relogins = 0;
  const client = createHttpClient({
    getToken: () => null,
    relogin: async () => { relogins += 1; },
    send: async () => {
      attempts += 1;
      return { statusCode: 401, data: { code: "UNAUTHORIZED", message: "请先登录" } };
    },
  });

  await assert.rejects(
    () => client.request({ url: "/api/auth/me" }),
    (error) => error instanceof BusinessError && error.code === "UNAUTHORIZED",
  );
  assert.equal(relogins, 0);
  assert.equal(attempts, 1);
});
test("request does not relogin when logout clears its token before a 401 response", async () => {
  let currentToken = "saved-token";
  let finishRequest;
  let relogins = 0;
  const response = new Promise((resolve) => { finishRequest = resolve; });
  const client = createHttpClient({
    getToken: () => currentToken,
    relogin: async () => { relogins += 1; },
    send: async () => response,
  });

  const request = client.request({ url: "/api/auth/me" });
  currentToken = null;
  finishRequest({ statusCode: 401, data: { code: "UNAUTHORIZED", message: "登录已失效" } });

  await assert.rejects(
    () => request,
    (error) => error instanceof BusinessError && error.code === "UNAUTHORIZED",
  );
  assert.equal(relogins, 0);
});
test("request retries with a newer token without relogin after a 401", async () => {
  let currentToken = "old-token";
  let relogins = 0;
  const authorizationHeaders = [];
  const client = createHttpClient({
    getToken: () => currentToken,
    relogin: async () => { relogins += 1; },
    send: async (request) => {
      authorizationHeaders.push(request.headers.Authorization);
      if (authorizationHeaders.length === 1) {
        currentToken = "new-token";
        return { statusCode: 401, data: { message: "old token expired" } };
      }
      return { statusCode: 200, data: { status: "ok" } };
    },
  });

  assert.deepEqual(await client.request({ url: "/api/auth/me" }), { status: "ok" });
  assert.deepEqual(authorizationHeaders, ["Bearer old-token", "Bearer new-token"]);
  assert.equal(relogins, 0);
});
test("request maps non-2xx responses to a business error", async () => {
  const client = createHttpClient({ getToken: () => null, relogin: async () => {}, send: async () => ({ statusCode: 422, data: { code: "INVALID_CODE", message: "无效登录码" } }) });
  await assert.rejects(() => client.request({ url: "/api/auth/wechat/login", method: "POST" }), (error) => error instanceof BusinessError && error.code === "INVALID_CODE");
});
test("request preserves FastAPI nested business codes for recoverable UI states", async () => {
  const client = createHttpClient({
    getToken: () => "token",
    relogin: async () => {},
    send: async () => ({
      statusCode: 429,
      data: { detail: { code: "WECHAT_PHONE_QUOTA_EXHAUSTED", message: "quota exhausted" } },
    }),
  });
  await assert.rejects(
    () => client.request({ url: "/api/auth/wechat/phone", method: "POST" }),
    (error) => error instanceof BusinessError
      && error.code === "WECHAT_PHONE_QUOTA_EXHAUSTED"
      && error.message === "quota exhausted",
  );
});
