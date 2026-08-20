const { getCurrentProfile, saveProfile, uploadAvatar } = require("../../services/profile");

Page({
  data: {
    nickname: "",
    avatarUrl: "",
    avatarTempPath: "",
    redirect: "",
    isLoading: false,
    errorMessage: "",
  },

  async onLoad(options) {
    let redirect = "";
    try {
      const candidate = decodeURIComponent((options && options.redirect) || "");
      if (candidate.startsWith("/pages/")) redirect = candidate;
    } catch (error) {
      redirect = "";
    }
    this.setData({ redirect, isLoading: true, errorMessage: "" });
    try {
      const profile = await getCurrentProfile();
      this.setData({
        nickname: profile.nickname || "",
        avatarUrl: profile.avatar_url || "",
      });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "资料加载失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onChooseAvatar(event) {
    const avatarTempPath = event && event.detail && event.detail.avatarUrl;
    if (avatarTempPath) this.setData({ avatarTempPath, errorMessage: "" });
  },

  onNicknameInput(event) {
    this.setData({ nickname: (event.detail.value || "").trim(), errorMessage: "" });
  },

  onNicknameBlur(event) {
    const nickname = (event.detail.value || "").trim();
    this.setData({
      nickname,
      errorMessage: nickname ? "" : "昵称未通过微信安全校验，请重新填写",
    });
  },

  async submit() {
    const nickname = (this.data.nickname || "").trim();
    if (!nickname) {
      this.setData({ errorMessage: "昵称未通过微信安全校验，请重新填写" });
      return;
    }
    if (!this.data.avatarTempPath && !this.data.avatarUrl) {
      this.setData({ errorMessage: "请选择头像" });
      return;
    }
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const avatarUrl = this.data.avatarTempPath
        ? await uploadAvatar(this.data.avatarTempPath)
        : this.data.avatarUrl;
      await saveProfile({ nickname, avatarUrl });
      this.finish();
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "资料保存失败，请重试" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  finish() {
    if (this.data.redirect) {
      if (["/pages/analyze/index", "/pages/profile/index"].includes(this.data.redirect)) {
        wx.switchTab({ url: this.data.redirect });
      } else {
        wx.redirectTo({ url: this.data.redirect });
      }
      return;
    }
    if (typeof wx.navigateBack === "function") wx.navigateBack();
  },
});
