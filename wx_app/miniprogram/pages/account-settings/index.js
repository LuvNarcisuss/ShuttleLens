const { bindPhone, logout } = require("../../services/auth");
const { getCurrentProfile } = require("../../services/profile");

function phoneFailureMessage(errMsg) {
  const value = String(errMsg || "").toLowerCase();
  if (value.includes("quota")) return "手机号验证额度不足，请稍后再试";
  if (value.includes("deny")) return "你已拒绝手机号授权，可点击按钮重新尝试";
  if (value.includes("cancel")) return "已取消手机号授权";
  return "未获取到手机号授权凭证";
}

Page({
  data: {
    accountId: "—",
    maskedPhone: "",
    wechatStatus: "已绑定",
    isLoading: true,
    errorMessage: "",
  },

  onShow() { return this.loadAccount(); },

  async loadAccount() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await getCurrentProfile();
      this.setData({
        accountId: String(profile.id || "—"),
        maskedPhone: profile.masked_phone || "",
      });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "账号信息加载失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async replacePhone(event) {
    const detail = (event && event.detail) || {};
    if (!detail.code) {
      this.setData({ errorMessage: phoneFailureMessage(detail.errMsg) });
      return;
    }
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await bindPhone(detail.code);
      this.setData({ maskedPhone: profile.masked_phone || "", errorMessage: "" });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "手机号更换失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  confirmLogout() {
    if (this.data.isLoading) return;
    wx.showModal({
      title: "退出登录",
      content: "退出后需要重新进行微信登录，是否继续？",
      confirmText: "退出",
      confirmColor: "#E5484D",
      success: ({ confirm }) => {
        if (!confirm) return;
        logout();
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },
});
