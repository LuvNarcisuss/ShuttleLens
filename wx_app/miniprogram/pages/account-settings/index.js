const {
  bindPhone,
  unbindPhone,
  unbindWechat,
  bindWechat,
  deactivateAccount,
  logout,
  setPassword,
} = require("../../services/auth");
const { getCurrentProfile } = require("../../services/profile");

function phoneFailureMessage(errMsg) {
  const value = String(errMsg || "").toLowerCase();
  if (value.includes("quota")) return "手机号验证额度不足，请稍后再试";
  if (value.includes("deny")) return "你已拒绝手机号授权，可点击按钮重新尝试";
  if (value.includes("cancel")) return "已取消手机号授权";
  return "未获取到手机号授权凭证";
}

function passwordErrorMessage(error) {
  const code = error && error.code;
  if (code === "PASSWORD_TOO_SHORT") return "密码长度至少8位";
  if (code === "PASSWORD_NO_DIGIT") return "密码必须包含至少一个数字";
  if (code === "PASSWORD_NO_LETTER") return "密码必须包含至少一个字母";
  return (error && error.message) || "密码设置失败";
}

Page({
  data: {
    accountId: "—",
    maskedPhone: "",
    phoneNumber: "",
    wechatBound: false,
    wechatStatus: "未绑定",
    passwordSet: false,
    isLoading: true,
    errorMessage: "",
    showPasswordModal: false,
    newPassword: "",
    confirmPassword: "",
  },

  onShow() { return this.loadAccount(); },

  async loadAccount() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await getCurrentProfile();
      this.setData({
        accountId: String(profile.account_number || profile.id || "—"),
        maskedPhone: profile.masked_phone || "",
        phoneNumber: profile.masked_phone || "",
        wechatBound: profile.wechat_bound !== false,
        wechatStatus: profile.wechat_bound === false ? "未绑定" : "已绑定",
        passwordSet: profile.password_set || false,
      });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "账号信息加载失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 手机号解绑
  onPhoneAction() {
    this.confirmUnbindPhone();
  },

  // 手机号绑定（微信授权回调）
  onGetPhoneNumber(event) {
    const detail = event.detail || {};
    if (detail.errMsg && detail.errMsg.includes('deny')) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "你已拒绝手机号授权", icon: "none" });
      this.setData({ errorMessage: "你已拒绝手机号授权，可点击按钮重新尝试" });
      return;
    }
    if (!detail.code) {
      this.setData({ errorMessage: phoneFailureMessage(detail.errMsg) });
      if (typeof wx.showToast === "function") {
        wx.showToast({ title: phoneFailureMessage(detail.errMsg), icon: "none" });
      }
      return;
    }
    return this.doBindPhone(detail.code);
  },

  replacePhone(event) { return this.onGetPhoneNumber(event); },

  async doBindPhone(phoneCode) {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await bindPhone(phoneCode);
      this.setData({
        phoneNumber: profile.masked_phone || "",
        maskedPhone: profile.masked_phone || "",
        errorMessage: "",
      });
      wx.showToast({ title: "绑定成功", icon: "success" });
    } catch (error) {
      const message = (error && error.message) || "手机号更换失败";
      this.setData({ errorMessage: message });
      if (typeof wx.showToast === "function") wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  confirmUnbindPhone() {
    if (this.data.isLoading) return;

    wx.showModal({
      title: "解绑手机号",
      content: "解绑后将无法通过手机号登录，是否继续？",
      confirmText: "解绑",
      confirmColor: "#E5484D",
      success: (res) => {
        if (!res.confirm) return;
        this.doUnbindPhone();
      },
    });
  },

  async doUnbindPhone() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      await unbindPhone();
      this.setData({
        phoneNumber: "",
        maskedPhone: "",
        errorMessage: "",
      });
      if (typeof wx.showToast === "function") wx.showToast({ title: "解绑成功", icon: "success" });
    } catch (error) {
      const message = (error && error.message) || "解绑失败";
      if (typeof wx.showToast === "function") wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 微信绑定/解绑
  onWechatAction() {
    if (this.data.isLoading) return;
    if (!this.data.wechatBound) return this.doBindWechat();
    wx.showModal({
      title: "解绑微信",
      content: "解绑后需要使用账号密码或手机号恢复登录，是否继续？",
      confirmText: "解绑",
      confirmColor: "#E5484D",
      success: ({ confirm }) => { if (confirm) this.doUnbindWechat(); },
    });
  },

  async doUnbindWechat() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      await unbindWechat();
      this.setData({ wechatBound: false, wechatStatus: "未绑定" });
      if (typeof wx.showToast === "function") wx.showToast({ title: "微信已解绑", icon: "success" });
    } catch (error) {
      const message = (error && error.message) || "微信解绑失败";
      this.setData({ errorMessage: message });
      if (typeof wx.showToast === "function") wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async doBindWechat() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await bindWechat();
      this.setData({ wechatBound: profile.wechat_bound !== false, wechatStatus: "已绑定" });
      if (typeof wx.showToast === "function") wx.showToast({ title: "微信绑定成功", icon: "success" });
    } catch (error) {
      const message = (error && error.message) || "微信绑定失败";
      this.setData({ errorMessage: message });
      if (typeof wx.showToast === "function") wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  // 密码设置/重置
  onPasswordAction() {
    if (this.data.isLoading) return;
    this.setData({ showPasswordModal: true, newPassword: "", confirmPassword: "" });
  },

  onNewPasswordInput(event) {
    this.setData({ newPassword: event.detail.value });
  },

  onConfirmPasswordInput(event) {
    this.setData({ confirmPassword: event.detail.value });
  },

  closePasswordModal() {
    this.setData({ showPasswordModal: false, newPassword: "", confirmPassword: "" });
  },

  preventClose() {
    // 阻止事件冒泡，防止点击弹窗内容时关闭弹窗
  },

  async confirmSetPassword() {
    const { newPassword, confirmPassword } = this.data;

    if (!newPassword || newPassword.length < 8) {
      wx.showToast({ title: "密码长度至少8位", icon: "none" });
      return;
    }

    if (newPassword !== confirmPassword) {
      wx.showToast({ title: "两次密码输入不一致", icon: "none" });
      return;
    }

    this.setData({ isLoading: true, errorMessage: "" });
    try {
      await setPassword(newPassword);
      this.setData({ showPasswordModal: false, passwordSet: true });
      wx.showToast({ title: "密码设置成功", icon: "success" });
    } catch (error) {
      const message = passwordErrorMessage(error);
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onLogout() {
    this.confirmLogout();
  },

  confirmLogout() {
    if (this.data.isLoading) return;
    wx.showModal({
      title: "退出登录",
      content: "退出后需要重新进行登录，是否继续？",
      confirmText: "退出",
      confirmColor: "#E5484D",
      success: ({ confirm }) => {
        if (!confirm) return;
        logout();
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },

  onSwitchAccount() {
    if (this.data.isLoading) return;
    logout();
    wx.reLaunch({ url: "/pages/login/index" });
  },

  onDeactivate() {
    if (this.data.isLoading) return;
    wx.showModal({
      title: "注销账号",
      content: "账号将被停用，分析记录会保留但无法再次登录。是否继续？",
      confirmText: "注销",
      confirmColor: "#E5484D",
      success: ({ confirm }) => { if (confirm) this.doDeactivate(); },
    });
  },

  async doDeactivate() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      await deactivateAccount();
      logout();
      wx.reLaunch({ url: "/pages/login/index" });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "账号注销失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },
});
