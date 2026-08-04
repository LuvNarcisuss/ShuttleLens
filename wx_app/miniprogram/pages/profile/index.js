const { listTasks } = require("../../services/analysis");
const { getCurrentProfile } = require("../../services/profile");
const { getAnalytics } = require("../../services/result");
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

const CAREER_METRICS = [
  ["average_speed_mps", "平均速度", "speed"],
  ["maximum_speed_mps", "最高速度", "speed"],
  ["distance_m", "移动距离", "distance"],
  ["court_coverage_ratio", "场地覆盖率", "ratio"],
  ["zones.front", "前场占比", "ratio"],
  ["zones.mid", "中场占比", "ratio"],
  ["zones.back", "后场占比", "ratio"],
  ["sides.left", "左侧占比", "ratio"],
  ["sides.right", "右侧占比", "ratio"],
];

function nestedValue(source, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function displayMetric(player, [key, label, kind]) {
  const raw = nestedValue(player, key);
  const metric = raw && typeof raw === "object" && "value" in raw ? raw : null;
  if (metric && metric.available === false) return { key, label, value: "—", unit: kind === "ratio" ? "%" : "" };
  const numeric = Number(metric ? metric.value : raw);
  if (!Number.isFinite(numeric)) return { key, label, value: "—", unit: kind === "ratio" ? "%" : "" };
  if (kind === "speed") return { key, label, value: (numeric * 3.6).toFixed(1), unit: "km/h" };
  if (kind === "distance") return { key, label, value: numeric.toFixed(1), unit: "m" };
  return { key, label, value: String(Math.round(numeric * 100)), unit: "%" };
}

function formatCareerMetrics(player = {}) {
  return CAREER_METRICS.map((definition) => displayMetric(player, definition));
}

function hasCareerData(player) {
  if (!player || typeof player !== "object" || Array.isArray(player)) return false;
  return CAREER_METRICS.some(([key]) => {
    const raw = nestedValue(player, key);
    const metric = raw && typeof raw === "object" && "value" in raw ? raw : null;
    if (metric) return metric.available === false || Number.isFinite(Number(metric.value));
    return raw !== null && raw !== "" && Number.isFinite(Number(raw));
  });
}

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
    tasksState: "loading",
    taskErrorMessage: "",
    errorMessage: "",
    accountDisplay: "",
    latestSucceededTaskId: "",
    careerState: "loading",
    careerMetrics: formatCareerMetrics(),
    careerErrorMessage: "",
  },

  onShow() {
    return this.loadPageData();
  },

  async loadPageData() {
    if (!getAccessToken()) {
      this.setData({
        profile: null,
        displayName: "微信用户",
        avatarUrl: "",
        maskedPhone: "",
        requiredSteps: [],
        isLoggedIn: false,
        loginStatus: "未登录",
        isLoading: false,
        tasks: [],
        tasksState: "empty",
        taskErrorMessage: "",
        errorMessage: "",
        accountDisplay: "",
        latestSucceededTaskId: "",
        careerState: "empty",
        careerMetrics: formatCareerMetrics(),
        careerErrorMessage: "",
      });
      return;
    }

    this.setData({
      isLoading: true,
      tasksState: "loading",
      taskErrorMessage: "",
      errorMessage: "",
      careerState: "loading",
      careerErrorMessage: "",
    });

    const profileRequest = getCurrentProfile()
      .then((profileValue) => {
        const profile = profileValue || {};
        this.setData({
          profile,
          displayName: profile.nickname || "微信用户",
          accountDisplay: profile.id == null ? "" : (String(profile.id).length <= 12 ? profile.id : `…${String(profile.id).slice(-8)}`),
          avatarUrl: profile.avatar_url || "",
          maskedPhone: profile.masked_phone || "",
          requiredSteps: Array.isArray(profile.required_steps) ? profile.required_steps : [],
          isLoggedIn: true,
          loginStatus: profile.onboarding_status === "active" ? "资料已完善" : "资料待完善",
          isLoading: false,
        });
        if (typeof wx.setStorageSync === "function") wx.setStorageSync("current_user", profile);
      })
      .catch(() => {
        this.setData({
          profile: null,
          displayName: "微信用户",
          accountDisplay: "",
          avatarUrl: "",
          maskedPhone: "",
          requiredSteps: [],
          isLoggedIn: Boolean(getAccessToken()),
          loginStatus: getAccessToken() ? "登录信息待刷新" : "未登录",
          isLoading: false,
        });
      });

    const tasksRequest = listTasks()
      .then(async (payload) => {
        const items = Array.isArray(payload) ? payload : (payload && payload.items) || [];
        const tasks = items.slice(0, 2).map(safeTask);
        const latestSucceededTask = items.find((item) => item.status === "succeeded");
        this.setData({
          tasks,
          tasksState: tasks.length ? "ready" : "empty",
          taskErrorMessage: "",
          latestSucceededTaskId: "",
          careerState: latestSucceededTask ? "loading" : "empty",
          careerMetrics: formatCareerMetrics(),
          careerErrorMessage: "",
        });
        if (!latestSucceededTask) return;

        try {
          const analytics = await getAnalytics(latestSucceededTask.id);
          const player = analytics && analytics.players && analytics.players.upper;
          if (!hasCareerData(player)) {
            this.setData({ careerState: "unavailable", careerErrorMessage: "本次结果暂无生涯数据" });
            return;
          }
          this.setData({
            latestSucceededTaskId: latestSucceededTask.id,
            careerState: "ready",
            careerMetrics: formatCareerMetrics(player),
            careerErrorMessage: "",
          });
        } catch (error) {
          this.setData({ careerState: "unavailable", careerErrorMessage: "本次结果暂无生涯数据" });
        }
      })
      .catch(() => {
        this.setData({
          tasks: [],
          tasksState: "unavailable",
          taskErrorMessage: "最近分析加载失败，请稍后重试",
          latestSucceededTaskId: "",
          careerState: "unavailable",
          careerMetrics: formatCareerMetrics(),
          careerErrorMessage: "生涯数据加载失败，请稍后重试",
        });
      });

    await Promise.allSettled([profileRequest, tasksRequest]);
  },

  login() {
    wx.navigateTo({
      url: "/pages/login/index?redirect=%2Fpages%2Fprofile%2Findex",
    });
  },

  editProfile() {
    wx.navigateTo({ url: "/pages/profile-edit/index" });
  },

  openTask(event) {
    const taskId = event.currentTarget.dataset.taskId;
    const task = this.data.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== "succeeded") return;
    wx.navigateTo({ url: `/pages/result/index?task_id=${taskId}` });
  },

  openAnalysisTasks() {
    wx.switchTab({ url: "/pages/tasks/index" });
  },

  openAccountSettings() {
    wx.navigateTo({ url: "/pages/account-settings/index" });
  },

  openCareerResult() {
    if (!this.data.latestSucceededTaskId) return;
    wx.navigateTo({ url: `/pages/result/index?task_id=${this.data.latestSucceededTaskId}` });
  },
});
