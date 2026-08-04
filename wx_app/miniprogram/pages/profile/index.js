const { listTasks } = require("../../services/analysis");
const { logout: clearLocalSession } = require("../../services/auth");
const { getCurrentProfile } = require("../../services/profile");
const { getAccessToken } = require("../../services/token");

const STATUS_LABELS = {
  created: "待校准",
  uploading: "上传中",
  queued: "排队中",
  running: "分析中",
  publishing: "生成结果",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function safeTask(task) {
  return {
    id: task.id,
    status: task.status,
    statusLabel: STATUS_LABELS[task.status] || "未知状态",
    progress: Number(task.progress) || 0,
    createdAt: task.created_at || "",
  };
}

Page({
  data: {
    profile: null,
    displayName: "微信用户",
    avatarUrl: "",
    maskedPhone: "",
    requiredSteps: [],
    isLoggedIn: false,
    loginStatus: "未登录",
    isLoading: true,
    tasks: [],
    errorMessage: "",
  },

  onShow() {
    return this.loadPageData();
  },

  async loadPageData() {
    this.setData({ isLoading: true, errorMessage: "" });
    const [profileResult, tasksResult] = await Promise.allSettled([
      getCurrentProfile(),
      listTasks(),
    ]);
    const patch = { isLoading: false };
    if (profileResult.status === "fulfilled") {
      const profile = profileResult.value || {};
      patch.profile = profile;
      patch.displayName = profile.nickname || "微信用户";
      patch.avatarUrl = profile.avatar_url || "";
      patch.maskedPhone = profile.masked_phone || "";
      patch.requiredSteps = Array.isArray(profile.required_steps) ? profile.required_steps : [];
      patch.isLoggedIn = true;
      patch.loginStatus = profile.onboarding_status === "active" ? "资料已完善" : "资料待完善";
      if (typeof wx.setStorageSync === "function") wx.setStorageSync("current_user", profile);
    } else {
      patch.isLoggedIn = Boolean(getAccessToken());
      patch.loginStatus = patch.isLoggedIn ? "登录信息待刷新" : "未登录";
      patch.maskedPhone = "";
      patch.requiredSteps = [];
    }
    if (tasksResult.status === "fulfilled") {
      const payload = tasksResult.value;
      const items = Array.isArray(payload) ? payload : (payload && payload.items) || [];
      patch.tasks = items.map(safeTask);
    } else {
      patch.tasks = [];
    }
    if (profileResult.status === "rejected" && tasksResult.status === "rejected") {
      patch.errorMessage = "资料与任务加载失败，请稍后重试";
    }
    this.setData(patch);
  },

  login() {
    wx.navigateTo({
      url: "/pages/login/index?redirect=%2Fpages%2Fprofile%2Findex",
    });
  },

  editProfile() {
    wx.navigateTo({ url: "/pages/profile-edit/index" });
  },

  logout() {
    clearLocalSession();
    this.setData({
      profile: null,
      displayName: "微信用户",
      avatarUrl: "",
      maskedPhone: "",
      requiredSteps: [],
      isLoggedIn: false,
      loginStatus: "未登录",
      tasks: [],
      errorMessage: "",
    });
  },

  openTask(event) {
    const taskId = event.currentTarget.dataset.taskId;
    const task = this.data.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== "succeeded") return;
    wx.navigateTo({ url: `/pages/result/index?task_id=${taskId}` });
  },
});
