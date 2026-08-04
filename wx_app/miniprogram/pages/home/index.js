const { ensureLogin } = require("../../services/auth");
const { getCurrentProfile } = require("../../services/profile");
const { getAccessToken } = require("../../services/token");

function getWechatProfile() {
  if (typeof wx.getUserProfile !== "function") {
    return Promise.reject(new Error("当前微信版本不支持快捷获取头像和昵称"));
  }
  return new Promise((resolve, reject) => wx.getUserProfile({
    desc: "用于完善个人资料",
    success: ({ userInfo }) => resolve(userInfo),
    fail: reject,
  }));
}

Page({
  data: { profile: null, status: "点击微信快捷登录以授权头像和昵称", isSubmitting: false },
  async onShow() {
    if (!getAccessToken() || this.data.profile) return;
    try {
      const profile = await getCurrentProfile();
      this.setData({ profile, status: "已登录" });
    } catch {}
  },
  async login() {
    this.setData({ status: "正在登录", isSubmitting: true });
    try {
      const userInfo = await getWechatProfile();
      const response = await ensureLogin({ nickname: userInfo.nickName, avatarUrl: userInfo.avatarUrl });
      this.setData({ profile: response.user, status: "登录成功", isSubmitting: false });
    } catch (error) {
      this.setData({ status: error.errMsg || error.message || "授权或登录失败，请重试", isSubmitting: false });
    }
  },
});
