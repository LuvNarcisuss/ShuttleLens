const { getCareerStats } = require("../../services/analysis");
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

const DATE_RANGE_OPTIONS = [
  { value: 'week', label: '最近一周' },
  { value: 'month', label: '最近一个月' },
  { value: 'three_months', label: '最近三个月' },
  { value: 'six_months', label: '最近半年' },
  { value: 'year', label: '最近一年' },
  { value: 'all', label: '全部' },
];

function formatCareerMetrics(stats = {}) {
  const number = (value, digits = 0) => Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
  const duration = Number(stats.total_duration_sec);
  const durationLabel = Number.isFinite(duration)
    ? (duration >= 60 ? `${Math.floor(duration / 60)}分${Math.round(duration % 60)}秒` : `${Math.round(duration)}秒`)
    : "—";
  return [
    { key: "total_matches", label: "比赛场次", value: number(stats.total_matches), unit: "场" },
    { key: "win_count", label: "胜", value: number(stats.win_count), unit: "" },
    { key: "loss_count", label: "负", value: number(stats.loss_count), unit: "" },
    { key: "draw_count", label: "平", value: number(stats.draw_count), unit: "" },
    { key: "win_rate", label: "胜率", value: Number.isFinite(stats.win_rate) ? `${(stats.win_rate * 100).toFixed(0)}%` : "—", unit: "" },
    { key: "total_duration", label: "总时长", value: durationLabel, unit: "" },
    { key: "total_rallies", label: "有效回合", value: number(stats.total_rallies), unit: "次" },
    { key: "average_speed", label: "平均速度", value: number(stats.avg_speed_mps * 3.6, 1), unit: "km/h" },
    { key: "maximum_speed", label: "最高速度", value: number(stats.max_speed_mps * 3.6, 1), unit: "km/h" },
    { key: "total_distance", label: "移动距离", value: number(stats.total_distance_m, 0), unit: "m" },
    { key: "coverage", label: "平均覆盖", value: number(stats.avg_court_coverage * 100, 0), unit: "%" },
  ];
}

Page({
  _loadGeneration: 0,

  data: {
    profile: null,
    displayName: "微信用户",
    avatarUrl: "",
    maskedPhone: "",
    requiredSteps: [],
    isLoggedIn: false,
    loginStatus: "未登录",
    isLoading: true,
    errorMessage: "",
    accountDisplay: "",
    // 生涯统计相关
    dateRangeOptions: DATE_RANGE_OPTIONS,
    selectedDateRange: 'all',
    selectedDateRangeIndex: 5,  // 默认"全部"
    careerState: "loading",
    careerStats: null,
    careerMetrics: formatCareerMetrics(),
    careerRecordMetrics: formatCareerMetrics().slice(0, 5),
    careerPerformanceMetrics: formatCareerMetrics().slice(5),
    recentMatches: [],
    careerErrorMessage: "",
  },

  onShow() {
    // 如果未登录，立即清空数据（确保退出登录后数据清零）
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
        errorMessage: "",
        accountDisplay: "",
        careerState: "empty",
        careerStats: null,
        careerMetrics: formatCareerMetrics(),
        careerRecordMetrics: formatCareerMetrics().slice(0, 5),
        careerPerformanceMetrics: formatCareerMetrics().slice(5),
        recentMatches: [],
        careerErrorMessage: "",
      });
      return;
    }
    return this.loadPageData();
  },

  async loadPageData() {
    const generation = this._loadGeneration + 1;
    this._loadGeneration = generation;
    const isCurrentGeneration = () => this._loadGeneration === generation;

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
        errorMessage: "",
        accountDisplay: "",
        careerState: "empty",
        careerStats: null,
        careerMetrics: formatCareerMetrics(),
        careerRecordMetrics: formatCareerMetrics().slice(0, 5),
        careerPerformanceMetrics: formatCareerMetrics().slice(5),
        recentMatches: [],
        careerErrorMessage: "",
      });
      return;
    }

    this.setData({
      isLoading: true,
      errorMessage: "",
      careerState: "loading",
      careerErrorMessage: "",
    });

    const profileRequest = getCurrentProfile()
      .then((profileValue) => {
        if (!isCurrentGeneration()) return;
        const profile = profileValue || {};
        this.setData({
          profile,
          displayName: profile.nickname || "微信用户",
          accountDisplay: profile.account_number || "",
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
        if (!isCurrentGeneration()) return;
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

    const careerRequest = this.loadCareerStats(this.data.selectedDateRange)
      .catch(() => {
        if (!isCurrentGeneration()) return;
        this.setData({
          careerState: "unavailable",
          careerStats: null,
          careerMetrics: formatCareerMetrics(),
          careerRecordMetrics: formatCareerMetrics().slice(0, 5),
          careerPerformanceMetrics: formatCareerMetrics().slice(5),
          recentMatches: [],
          careerErrorMessage: "生涯数据加载失败，请稍后重试",
        });
      });

    await Promise.allSettled([profileRequest, careerRequest]);
  },

  async loadCareerStats(dateRange = 'all') {
    const generation = this._loadGeneration;
    const isCurrentGeneration = () => this._loadGeneration === generation;

    this.setData({ careerState: "loading", careerErrorMessage: "" });

    try {
      const stats = await getCareerStats(dateRange);
      if (!isCurrentGeneration()) return;

      if (!stats || stats.total_matches === 0) {
        const careerMetrics = formatCareerMetrics(stats);
        this.setData({
          careerState: "empty",
          careerStats: null,
          careerMetrics,
          careerRecordMetrics: careerMetrics.slice(0, 5),
          careerPerformanceMetrics: careerMetrics.slice(5),
          recentMatches: [],
          careerErrorMessage: "",
        });
        return;
      }

      const careerMetrics = formatCareerMetrics(stats);
      this.setData({
        careerState: "ready",
        careerStats: {
          totalMatches: stats.total_matches,
          matchedMatches: stats.matched_matches,
          totalDuration: this.formatDuration(stats.total_duration_sec),
          totalRallies: stats.total_rallies,
          avgSpeed: (stats.avg_speed_mps * 3.6).toFixed(1),
          maxSpeed: (stats.max_speed_mps * 3.6).toFixed(1),
          totalDistance: stats.total_distance_m.toFixed(0),
          avgCoverage: (stats.avg_court_coverage * 100).toFixed(1),
          winCount: stats.win_count,
          lossCount: stats.loss_count,
          drawCount: stats.draw_count,
          winRate: stats.win_rate ? (stats.win_rate * 100).toFixed(1) + '%' : '-',
          recentMatches: stats.recent_matches || [],
        },
        careerMetrics,
        careerRecordMetrics: careerMetrics.slice(0, 5),
        careerPerformanceMetrics: careerMetrics.slice(5),
        recentMatches: (stats.recent_matches || []).map((item) => ({
          id: item.task_id,
          name: item.name || "未命名分析",
          result: item.match_result === "win" ? "胜" : item.match_result === "loss" ? "负" : "平",
          resultClass: item.match_result || "draw",
        })),
        careerErrorMessage: "",
      });
    } catch (error) {
      if (!isCurrentGeneration()) return;
      this.setData({
        careerState: "unavailable",
        careerStats: null,
        careerMetrics: formatCareerMetrics(),
        careerRecordMetrics: formatCareerMetrics().slice(0, 5),
        careerPerformanceMetrics: formatCareerMetrics().slice(5),
        recentMatches: [],
        careerErrorMessage: "生涯数据加载失败，请稍后重试",
      });
    }
  },

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0秒';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}小时${minutes}分`;
    }
    if (minutes > 0) {
      return `${minutes}分${secs}秒`;
    }
    return `${secs}秒`;
  },

  onDateRangeChange(e) {
    const index = Number(e.detail.value);
    const range = DATE_RANGE_OPTIONS[index].value;
    this.setData({
      selectedDateRange: range,
      selectedDateRangeIndex: index,
    });
    this.loadCareerStats(range);
  },

  login() {
    wx.navigateTo({
      url: "/pages/login/index?redirect=%2Fpages%2Fprofile%2Findex",
    });
  },

  editProfile() {
    wx.navigateTo({ url: "/pages/profile-edit/index" });
  },

  openAnalysisTasks() {
    wx.switchTab({ url: "/pages/tasks/index" });
  },

  openAccountSettings() {
    wx.navigateTo({ url: "/pages/account-settings/index" });
  },

});
