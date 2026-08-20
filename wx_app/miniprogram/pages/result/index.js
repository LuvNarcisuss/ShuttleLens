const {
  getResultTask,
  loadResultResources,
  getAnalytics,
  getHighlights,
  updateHighlight,
  createHighlightClip,
  createShare,
} = require("../../services/result");
const {
  downloadTaskFile,
  saveVideoToAlbum,
  saveImageToAlbum,
  openAlbumSettings,
  isAlbumPermissionDenied,
} = require("../../services/download");

function message(error, fallback) {
  return (error && (error.message || error.errMsg)) || fallback;
}

const METRIC_LABELS = {
  duration_sec: "比赛时长",
  rally_count: "有效回合",
  average_rally_duration_sec: "平均回合",
  longest_rally_duration_sec: "最长回合",
  distance_m: "移动距离",
  average_speed_mps: "平均速度",
  maximum_speed_mps: "最高速度",
  court_coverage_ratio: "场地覆盖",
};
const MATCH_RESULT_LABELS = {
  win: "胜",
  loss: "负",
  draw: "平",
};

function metricCards(metrics = {}, fallbackConfidence = "unknown") {
  const cards = Object.entries(metrics).filter(([, metric]) => metric && typeof metric === "object" && "value" in metric).map(([key, metric]) => ({
    key,
    label: METRIC_LABELS[key] || key,
    value: metric.available === false ? "暂不可用" : metric.value,
    unit: metric.unit || "",
    source: metric.source || "未标注",
    confidence: metric.confidence || fallbackConfidence,
    reason: metric.reason || "",
  }));
  if (metrics.zones) {
    cards.push({ key: "zones", label: "前中后场分布", value: `前 ${Math.round((metrics.zones.front || 0) * 100)}% · 中 ${Math.round((metrics.zones.mid || 0) * 100)}% · 后 ${Math.round((metrics.zones.back || 0) * 100)}%`, unit: "ratio", source: "detections.jsonl:court", confidence: fallbackConfidence, reason: "" });
  }
  if (metrics.sides) {
    cards.push({ key: "sides", label: "左右区域分布", value: `左 ${Math.round((metrics.sides.left || 0) * 100)}% · 右 ${Math.round((metrics.sides.right || 0) * 100)}%`, unit: "ratio", source: "detections.jsonl:court", confidence: fallbackConfidence, reason: "" });
  }
  return cards;
}

Page({
  data: {
    taskId: "",
    matchResult: "",
    matchResultLabel: "",
    pageState: "loading",
    progress: 0,
    errorMessage: "",
    videoPath: "",
    imagePaths: [],
    savingVideo: false,
    savingImageIndex: -1,
    downloadProgress: 0,
    permissionDenied: false,
    saveErrorMessage: "",
    scope: "match",
    selectedPlayer: "upper",
    selectedRallyId: "",
    metricCards: [],
    analytics: null,
    quality: null,
    rallies: [],
    highlights: [],
    highlightEditorOpen: false,
    highlightDraft: null,
    savingHighlight: false,
    structuredUnavailable: false,
    savingClipId: "",
    sharingReport: false,
    // 球员标签相关
    playerPosition: null,  // 'upper' | 'lower' | 'skip' | null
    myPosition: null,  // 用户选择的位置
    playerLabels: { upper: "上方球员", lower: "下方球员" },
    playerTabs: [],
  },

  async onLoad(options) {
    const taskId = (options && options.task_id) || "";
    if (!taskId) {
      this.setData({ pageState: "failed", errorMessage: "缺少任务 ID" });
      return;
    }
    this.setData({ taskId, pageState: "loading", errorMessage: "" });
    try {
      const task = await getResultTask(taskId);
      const progress = Number(task.progress) || 0;
      if (task.status === "failed") {
        this.setData({ pageState: "failed", progress, errorMessage: task.error_message || "分析任务失败" });
        return;
      }
      if (task.status !== "succeeded") {
        this.setData({ pageState: "pending", progress });
        return;
      }
      this.setData({
        matchResult: MATCH_RESULT_LABELS[task.match_result] ? task.match_result : "",
        matchResultLabel: MATCH_RESULT_LABELS[task.match_result] || "",
      });
      try {
        const [resources, analytics, highlightPayload] = await Promise.all([
          loadResultResources(taskId, task.result || {}),
          typeof getAnalytics === "function" ? Promise.resolve().then(() => getAnalytics(taskId)).catch(() => null) : Promise.resolve(null),
          typeof getHighlights === "function" ? Promise.resolve().then(() => getHighlights(taskId)).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        ]);

        // 根据 player_position 设置球员标签
        const playerPosition = task.player_position;
        let myPosition = null;
        let playerLabels = { upper: "上方球员", lower: "下方球员" };
        if (playerPosition && playerPosition !== 'skip') {
          // 用户选择了球员
          myPosition = playerPosition;
          const opponentPosition = myPosition === 'upper' ? 'lower' : 'upper';
          playerLabels = {
            [myPosition]: "自己",
            [opponentPosition]: "对手",
          };
        }
        const playerTabs = myPosition
          ? [myPosition, myPosition === "upper" ? "lower" : "upper"].map((position) => ({ position, label: playerLabels[position] }))
          : ["upper", "lower"].map((position) => ({ position, label: playerLabels[position] }));

        this.setData({
          pageState: "ready",
          progress: 100,
          videoPath: resources.videoPath || "",
          imagePaths: Array.isArray(resources.imagePaths) ? resources.imagePaths : [],
          analytics,
          structuredUnavailable: !analytics,
          quality: analytics && analytics.quality,
          rallies: analytics && Array.isArray(analytics.rallies) ? analytics.rallies : [],
          highlights: Array.isArray(highlightPayload.items) ? highlightPayload.items : [],
          selectedRallyId: analytics && analytics.rallies && analytics.rallies[0] ? analytics.rallies[0].id : "",
          metricCards: metricCards((analytics && analytics.match) || {}),
          playerPosition,
          myPosition,
          playerLabels,
          selectedPlayer: myPosition || 'upper',
          playerTabs,
        });
      } catch (error) {
        this.setData({ pageState: "resource_error", progress: 100, errorMessage: message(error, "结果资源加载失败") });
      }
    } catch (error) {
      this.setData({ pageState: "failed", errorMessage: message(error, "任务加载失败") });
    }
  },

  onReady() {
    if (typeof wx.createVideoContext === "function") {
      this.videoContext = wx.createVideoContext("result-video");
    }
  },

  metricsForScope(scope = this.data.scope) {
    const analytics = this.data.analytics || {};
    const confidence = (analytics.quality || {}).confidence || "unknown";
    if (scope === "player") return metricCards((analytics.players || {})[this.data.selectedPlayer] || {}, confidence);
    if (scope === "rally") {
      const rally = (this.data.rallies || []).find((item) => item.id === this.data.selectedRallyId);
      if (!rally) return [];
      return [
        { key: "duration_sec", label: "回合时长", value: rally.duration_sec, unit: "s", source: "detections:frame_gaps", confidence: (analytics.quality || {}).confidence || "unknown", reason: "" },
        ...metricCards(((rally.players || {})[this.data.selectedPlayer]) || {}, confidence),
      ];
    }
    return metricCards(analytics.match || {});
  },

  changeScope(event) {
    const scope = event.currentTarget.dataset.scope;
    if (!["match", "player", "rally"].includes(scope)) return;
    this.setData({ scope });
    this.setData({ metricCards: this.metricsForScope(scope) });
  },

  selectPlayer(event) {
    this.setData({ selectedPlayer: event.currentTarget.dataset.player });
    this.setData({ metricCards: this.metricsForScope() });
  },

  selectRally(event) {
    const selectedRallyId = event.currentTarget.dataset.id;
    this.setData({ selectedRallyId, scope: "rally" });
    this.setData({ metricCards: this.metricsForScope("rally") });
    this.seekTo({ currentTarget: { dataset: { seconds: event.currentTarget.dataset.seconds } } });
  },

  seekTo(event) {
    const seconds = Number(event.currentTarget.dataset.seconds);
    if (this.videoContext && Number.isFinite(seconds)) this.videoContext.seek(seconds);
  },

  editHighlight(event) {
    const item = this.data.highlights[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    this.setData({ highlightEditorOpen: true, highlightDraft: { ...item, title: item.title || "" } });
  },

  onHighlightField(event) {
    if (!this.data.highlightDraft) return;
    const field = event.currentTarget.dataset.field;
    let value = event.detail.value;
    if (field === "start_sec" || field === "end_sec") value = Number(value);
    if (field === "selected") value = Boolean(value);
    this.setData({ highlightDraft: { ...this.data.highlightDraft, [field]: value } });
  },

  restoreHighlightRange() {
    const draft = this.data.highlightDraft;
    if (!draft) return;
    this.setData({ highlightDraft: { ...draft, start_sec: draft.system_start_sec, end_sec: draft.system_end_sec } });
  },

  closeHighlightEditor() { this.setData({ highlightEditorOpen: false, highlightDraft: null }); },
  noop() {},

  async saveHighlight() {
    const draft = this.data.highlightDraft;
    if (!draft || this.data.savingHighlight) return;
    if (!Number.isFinite(draft.start_sec) || !Number.isFinite(draft.end_sec) || draft.end_sec <= draft.start_sec) {
      this.setData({ saveErrorMessage: "高光结束时间必须晚于开始时间。" });
      return;
    }
    this.setData({ savingHighlight: true, saveErrorMessage: "" });
    try {
      const payload = await updateHighlight(this.data.taskId, draft.id, {
        start_sec: draft.start_sec,
        end_sec: draft.end_sec,
        selected: draft.selected !== false,
        title: draft.title || null,
      });
      this.setData({ highlights: Array.isArray(payload.items) ? payload.items : this.data.highlights, highlightEditorOpen: false, highlightDraft: null });
      if (typeof wx.showToast === "function") wx.showToast({ title: "高光已更新", icon: "success" });
    } catch (error) {
      this.setData({ saveErrorMessage: message(error, "高光保存失败，请重试") });
    } finally {
      this.setData({ savingHighlight: false });
    }
  },

  async saveHighlightClip(event) {
    const highlightId = event.currentTarget.dataset.id;
    if (!highlightId || this.data.savingClipId) return;
    this.setData({ savingClipId: highlightId, downloadProgress: 0, permissionDenied: false, saveErrorMessage: "" });
    try {
      await createHighlightClip(this.data.taskId, highlightId);
      const path = await downloadTaskFile({
        taskId: this.data.taskId,
        kind: "clips",
        resourceKey: highlightId,
        onProgress: (downloadProgress) => this.setData({ downloadProgress }),
      });
      await saveVideoToAlbum(path);
      if (typeof wx.showToast === "function") wx.showToast({ title: "精彩片段已保存", icon: "success" });
    } catch (error) {
      if (isAlbumPermissionDenied(error)) {
        this.setData({ permissionDenied: true, saveErrorMessage: "相册权限已被拒绝，请前往设置允许后重试。" });
      } else {
        this.setData({ saveErrorMessage: message(error, "精彩片段保存失败，请重试") });
      }
    } finally {
      this.setData({ savingClipId: "" });
    }
  },

  async shareReport() {
    if (this.data.sharingReport) return;
    this.setData({ sharingReport: true, saveErrorMessage: "" });
    try {
      const share = await createShare(this.data.taskId, { resource_kind: "report", expires_in_hours: 24 });
      if (typeof wx.setClipboardData === "function") {
        await new Promise((resolve, reject) => wx.setClipboardData({ data: share.share_path, success: resolve, fail: reject }));
      }
      if (typeof wx.showToast === "function") wx.showToast({ title: "24 小时分享路径已复制", icon: "success" });
    } catch (error) {
      this.setData({ saveErrorMessage: message(error, "分享链接创建失败") });
    } finally {
      this.setData({ sharingReport: false });
    }
  },

  previewImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const current = this.data.imagePaths[index];
    if (!current) return;
    wx.previewImage({ current, urls: this.data.imagePaths });
  },

  async saveVideo() {
    if (this.data.savingVideo || !this.data.videoPath) return;
    this.setData({ savingVideo: true, downloadProgress: 0, permissionDenied: false, saveErrorMessage: "" });
    try {
      const filePath = await downloadTaskFile({
        taskId: this.data.taskId,
        kind: "video",
        onProgress: (downloadProgress) => this.setData({ downloadProgress }),
      });
      this.setData({ downloadProgress: 100 });
      await saveVideoToAlbum(filePath);
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      if (isAlbumPermissionDenied(error)) {
        this.setData({ permissionDenied: true, saveErrorMessage: "相册权限已被拒绝，请前往设置允许后重试。" });
      } else {
        this.setData({ saveErrorMessage: message(error, "视频保存失败，请重试") });
      }
    } finally {
      this.setData({ savingVideo: false });
    }
  },

  async saveImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!this.data.imagePaths[index] || this.data.savingImageIndex >= 0) return;
    this.setData({ savingImageIndex: index, downloadProgress: 0, permissionDenied: false, saveErrorMessage: "" });
    try {
      const filePath = await downloadTaskFile({
        taskId: this.data.taskId,
        kind: "visualization",
        index,
        onProgress: (downloadProgress) => this.setData({ downloadProgress }),
      });
      this.setData({ downloadProgress: 100 });
      await saveImageToAlbum(filePath);
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      if (isAlbumPermissionDenied(error)) {
        this.setData({ permissionDenied: true, saveErrorMessage: "相册权限已被拒绝，请前往设置允许后重试。" });
      } else {
        this.setData({ saveErrorMessage: message(error, "图表保存失败，请重试") });
      }
    } finally {
      this.setData({ savingImageIndex: -1 });
    }
  },

  async openAlbumSettings() {
    try {
      const granted = await openAlbumSettings();
      this.setData({
        permissionDenied: !granted,
        saveErrorMessage: granted ? "相册权限已恢复，请重新点击保存。" : "尚未获得相册权限，您可以取消并继续浏览结果。",
      });
    } catch (error) {
      this.setData({ saveErrorMessage: message(error, "未能打开设置，请稍后重试") });
    }
  },

});
