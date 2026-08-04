const assert = require("node:assert/strict");
const test = require("node:test");
const { createProfileClient } = require("../../miniprogram/services/profile");

test("profile client saves the selected nickname and uploaded avatar URL", async () => {
  let receivedRequest;
  const client = createProfileClient({
    request: async (request) => {
      receivedRequest = request;
      return { nickname: "羽球小将", avatar_url: "https://api.example.com/uploads/avatar.jpg" };
    },
  });

  const profile = await client.saveProfile({
    nickname: "羽球小将",
    avatarUrl: "https://api.example.com/uploads/avatar.jpg",
  });

  assert.equal(receivedRequest.method, "PUT");
  assert.equal(receivedRequest.data.nickname, "羽球小将");
  assert.equal(receivedRequest.data.avatar_url, "https://api.example.com/uploads/avatar.jpg");
  assert.equal(profile.nickname, "羽球小将");
});

test("profile client retrieves the current user profile", async () => {
  let receivedRequest;
  const client = createProfileClient({
    request: async (request) => {
      receivedRequest = request;
      return { nickname: "羽球小将", avatar_url: "https://api.example.com/avatar.jpg" };
    },
  });

  assert.equal((await client.getCurrentProfile()).nickname, "羽球小将");
  assert.equal(receivedRequest.method, "GET");
  assert.match(receivedRequest.url, /\/auth\/me$/);
});
