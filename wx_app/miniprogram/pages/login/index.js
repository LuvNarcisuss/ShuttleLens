const { bindPhone, ensureLogin, loginByAccount, restoreSession } = require("../../services/auth");

function requiredSteps(payload) {
  return Array.isArray(payload && payload.required_steps) ? payload.required_steps : [];
}

function phoneEventMessage(errMsg) {
  const value = String(errMsg || "").toLowerCase();
  if (value.includes("quota")) return "手机号验证额度不足，请稍后再试";
  if (value.includes("deny")) return "你已拒绝手机号授权，可点击按钮重新尝试";
  if (value.includes("cancel")) return "已取消手机号授权，可稍后重试";
  return "未获取到手机号授权凭证，请重新尝试";
}

function phoneErrorMessage(error) {
  const code = error && error.code;
  if (code === "WECHAT_PHONE_CODE_EXPIRED") return "手机号授权已过期，请重新授权";
  if (code === "WECHAT_PHONE_CODE_INVALID") return "手机号授权无效，请重新授权";
  if (code === "WECHAT_PHONE_QUOTA_EXHAUSTED") return "手机号验证额度不足，请稍后再试";
  if (code === "PHONE_ALREADY_BOUND") return "该手机号已绑定其他账号，不能自动合并";
  if (code === "WECHAT_UPSTREAM_UNAVAILABLE") return "微信手机号服务暂不可用，请稍后重试";
  return (error && error.message) || "手机号绑定失败，请重试";
}

function accountErrorMessage(error) {
  const code = error && error.code;
  if (["ACCOUNT_NOT_FOUND", "PASSWORD_NOT_SET", "INVALID_PASSWORD", "ACCOUNT_LOGIN_FAILED"].includes(code)) {
    return "账号或密码错误";
  }
  if (code === "PASSWORD_TOO_SHORT") return "密码长度至少8位";
  if (code === "PASSWORD_NO_DIGIT") return "密码必须包含至少一个数字";
  if (code === "PASSWORD_NO_LETTER") return "密码必须包含至少一个字母";
  return (error && error.message) || "登录失败，请重试";
}

Page({
  data: {
    step: "agreement",
    agreed: false,
    isLoading: false,
    errorMessage: "",
    redirect: "",
    accountNumber: "",
    password: "",
  },

  onLoad(options) {
    let redirect = "";
    try {
      const candidate = decodeURIComponent((options && options.redirect) || "");
      if (candidate.startsWith("/pages/")) redirect = candidate;
    } catch (error) {
      redirect = "";
    }
    this.setData({ redirect });
  },

  async onShow() {
    if (this.hasRestoredSession) return;
    this.hasRestoredSession = true;
    try {
      const session = await restoreSession();
      if (session) this.applyRequiredSteps(session);
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "登录状态恢复失败" });
    }
  },

  onAgreementChange(event) {
    const agreed = Array.isArray(event.detail.value) && event.detail.value.includes("agreed");
    this.setData({ agreed, step: agreed ? "wechat_login" : "agreement", errorMessage: "" });
  },

  showAccountLogin() {
    if (!this.data.agreed) {
      wx.showToast({ title: "请先阅读并同意服务协议与隐私保护指引", icon: "none" });
      return;
    }
    this.setData({ step: "account_login", errorMessage: "" });
  },

  showWechatLogin() {
    this.setData({ step: "wechat_login", errorMessage: "", accountNumber: "", password: "" });
  },

  onAccountNumberInput(event) {
    this.setData({ accountNumber: event.detail.value });
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value });
  },

  async login() {
    if (!this.data.agreed) {
      if (typeof wx.showToast === "function") {
        wx.showToast({ title: "请先阅读并同意服务协议与隐私保护指引", icon: "none" });
      }
      return;
    }
    this.setData({ isLoading: true, errorMessage: "", step: "wechat_login" });
    try {
      this.applyRequiredSteps(await ensureLogin());
    } catch (error) {
      this.setData({ errorMessage: (error && (error.errMsg || error.message)) || "微信登录失败，请重试" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async loginByAccount() {
    if (!this.data.agreed) {
      if (typeof wx.showToast === "function") {
        wx.showToast({ title: "请先阅读并同意服务协议与隐私保护指引", icon: "none" });
      }
      return;
    }
    const { accountNumber, password } = this.data;
    if (!accountNumber || accountNumber.length !== 8) {
      this.setData({ errorMessage: "请输入8位数字账号" });
      return;
    }
    if (!password || password.length < 8) {
      this.setData({ errorMessage: "密码长度至少8位" });
      return;
    }

    this.setData({ isLoading: true, errorMessage: "" });
    try {
      this.applyRequiredSteps(await loginByAccount(accountNumber, password));
    } catch (error) {
      this.setData({ errorMessage: accountErrorMessage(error) });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async bindPhone(event) {
    const detail = (event && event.detail) || {};
    if (!detail.code) {
      this.setData({ errorMessage: phoneEventMessage(detail.errMsg) });
      return;
    }
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      this.applyRequiredSteps(await bindPhone(detail.code));
    } catch (error) {
      this.setData({ errorMessage: phoneErrorMessage(error) });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  applyRequiredSteps(payload) {
    const steps = requiredSteps(payload);
    if (steps.includes("bind_phone")) {
      this.setData({ step: "phone_binding" });
      return;
    }
    if (steps.includes("complete_profile")) {
      this.setData({ step: "profile_completion" });
      return;
    }
    this.finishLogin();
  },

  goProfileEdit() {
    const query = this.data.redirect ? `?redirect=${encodeURIComponent(this.data.redirect)}` : "";
    wx.navigateTo({ url: `/pages/profile-edit/index${query}` });
  },

  finishLogin() {
    this.setData({ step: "complete", errorMessage: "" });
    if (this.data.redirect) {
      wx.redirectTo({ url: this.data.redirect });
    } else if (typeof wx.switchTab === "function") {
      wx.switchTab({ url: "/pages/profile/index" });
    }
  },

  showAgreement() {
    wx.showModal({ title: "服务协议", content: "请在使用前阅读并同意服务协议。", showCancel: false });
  },

  showPrivacyGuide() {
    wx.showModal({ title: "隐私保护指引", content: "手机号仅用于账号验证，页面只展示脱敏号码。", showCancel: false });
  },
});
