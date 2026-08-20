const {
  listTasks,
  cancelTask,
  retryTask,
  reanalyzeTask,
  deleteTask,
} = require("../../services/analysis");
const { downloadTaskFile } = require("../../services/download");
const { getAccessToken } = require("../../services/token");

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
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
const STAGE_LABELS = {
  draft: "等待选择视频",
  uploading: "正在准备视频",
  calibration: "等待球场校准",
  ready: "可以开始分析",
  queued: "等待分析资源",
  analysis: "正在逐帧分析",
  publishing: "正在整理复盘结果",
  completed: "复盘结果已生成",
  failed: "分析未完成",
  cancelled: "任务已取消",
};
const MATCH_RESULT_LABELS = {
  win: "胜",
  loss: "负",
  draw: "平",
};

function displayTask(task) {
  const metadata = task.video_metadata || {};
  return {
    ...task,
    name: task.name || "未命名分析",
    statusLabel: STATUS_LABELS[task.status] || task.status,
    stageLabel: STAGE_LABELS[task.stage] || task.stage || "等待处理",
    progress: Number(task.progress) || 0,
    durationLabel: Number(metadata.duration_sec) > 0 ? `${Number(metadata.duration_sec).toFixed(1)} 秒` : "时长未知",
    createdLabel: task.created_at ? String(task.created_at).replace("T", " ").slice(0, 16) : "时间未知",
    matchResultLabel: MATCH_RESULT_LABELS[task.match_result] || "",
    coverPath: "",
  };
}

function errorMessage(error, fallback) {
  return (error && (error.message || error.errMsg)) || fallback;
}

Page({
  data: {
    tasks: [],
    total: 0,
    nextCursor: "",
    statusFilter: "",
    filters: [
      { value: "", label: "全部" },
      { value: "running", label: "进行中" },
      { value: "succeeded", label: "已完成" },
      { value: "failed", label: "失败" },
      { value: "cancelled", label: "已取消" },
    ],
    isLoading: false,
    isLoadingMore: false,
    errorMessage: "",
  },

  async onShow() {
    // 如果未登录，立即清空数据（确保退出登录后数据清零）
    if (!getAccessToken()) {
      this.stopPolling();
      this.setData({
        tasks: [],
        total: 0,
        nextCursor: "",
        isLoading: false,
        isLoadingMore: false,
        errorMessage: "",
      });
      return;
    }

    const generation = (this.visibilityGeneration || 0) + 1;
    this.visibilityGeneration = generation;
    this.isActive = true;
    this.stopPolling();
    await this.refreshTasks();
    if (this.isActive && this.visibilityGeneration === generation) this.startPolling();
  },

  onHide() {
    this.isActive = false;
    this.visibilityGeneration = (this.visibilityGeneration || 0) + 1;
    this.stopPolling();
  },

  onUnload() {
    this.isActive = false;
    this.visibilityGeneration = (this.visibilityGeneration || 0) + 1;
    this.stopPolling();
  },

  async refreshTasks({ silent = false } = {}) {
    if (!silent) this.setData({ isLoading: true, errorMessage: "" });
    try {
      const payload = await listTasks({ status: this.data.statusFilter, cursor: "", limit: 20 });
      if (this.isActive === false) return;
      const tasks = ((payload && payload.items) || []).map(displayTask);
      this.setData({
        tasks,
        total: Number(payload && payload.total) || tasks.length,
        nextCursor: (payload && payload.next_cursor) || "",
        errorMessage: "",
      });
      this.hydrateCovers(tasks);
    } catch (error) {
      if (this.isActive !== false) this.setData({ errorMessage: errorMessage(error, "任务加载失败，请下拉重试") });
    } finally {
      if (!silent && this.isActive !== false) this.setData({ isLoading: false });
    }
  },

  async loadNextPage() {
    if (!this.data.nextCursor || this.data.isLoadingMore) return;
    this.setData({ isLoadingMore: true });
    try {
      const payload = await listTasks({
        status: this.data.statusFilter,
        cursor: this.data.nextCursor,
        limit: 20,
      });
      const incoming = ((payload && payload.items) || []).map(displayTask);
      const existingIds = new Set(this.data.tasks.map((item) => item.id));
      const tasks = [...this.data.tasks, ...incoming.filter((item) => !existingIds.has(item.id))];
      this.setData({ tasks, nextCursor: (payload && payload.next_cursor) || "" });
      this.hydrateCovers(incoming);
    } catch (error) {
      this.setData({ errorMessage: errorMessage(error, "更多任务加载失败") });
    } finally {
      this.setData({ isLoadingMore: false });
    }
  },

  async onPullDownRefresh() {
    try {
      await this.refreshTasks();
    } finally {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    }
  },

  onReachBottom() {
    return this.loadNextPage();
  },

  async hydrateCovers(tasks) {
    if (typeof downloadTaskFile !== "function") return;
    for (const task of tasks.filter((item) => item.cover_available).slice(0, 6)) {
      try {
        const coverPath = await downloadTaskFile({ taskId: task.id, kind: "calibration", index: 0 });
        if (this.isActive === false) return;
        const index = this.data.tasks.findIndex((item) => item.id === task.id);
        if (index >= 0) this.setData({ [`tasks[${index}].coverPath`]: coverPath });
      } catch {}
    }
  },

  startPolling() {
    this.stopPolling();
    if (!this.data.tasks.some((task) => !TERMINAL_STATUSES.has(task.status))) return;
    this.pollTimer = setInterval(() => this.refreshTasks({ silent: true }), 5000);
  },

  stopPolling() {
    if (this.pollTimer !== undefined && this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  selectFilter(event) {
    const statusFilter = event.currentTarget.dataset.status || "";
    if (statusFilter === this.data.statusFilter) return;
    this.setData({ statusFilter, tasks: [], nextCursor: "" });
    return this.onShow();
  },

  createAnalysis() {
    wx.navigateTo({ url: "/pages/analyze/index" });
  },

  openTask(event) {
    const task = this.data.tasks.find((item) => item.id === event.currentTarget.dataset.taskId);
    if (!task) return;
    const page = task.status === "succeeded" ? "result" : "analyze";
    wx.navigateTo({ url: `/pages/${page}/index?task_id=${task.id}` });
  },

  async runAction(event) {
    const taskId = event.currentTarget.dataset.taskId;
    const action = event.currentTarget.dataset.action;
    const actions = { cancel: cancelTask, retry: retryTask, reanalyze: reanalyzeTask };
    if (!taskId || typeof actions[action] !== "function") return;
    try {
      const result = await actions[action](taskId);
      if (action === "reanalyze" && result && result.id) {
        wx.navigateTo({ url: `/pages/analyze/index?task_id=${result.id}` });
        return;
      }
      await this.refreshTasks();
    } catch (error) {
      this.setData({ errorMessage: errorMessage(error, "操作失败，请稍后重试") });
    }
  },

  deleteTask(event) {
    const taskId = event.currentTarget.dataset.taskId;
    if (!taskId || typeof deleteTask !== "function") return;
    wx.showModal({
      title: "隐藏这项任务？",
      content: "任务将从列表中移除，当前版本不会立即清理原始媒体。",
      confirmText: "隐藏",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await deleteTask(taskId);
          await this.refreshTasks();
        } catch (error) {
          this.setData({ errorMessage: errorMessage(error, "任务删除失败") });
        }
      },
    });
  },
});
