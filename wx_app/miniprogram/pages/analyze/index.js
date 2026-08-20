const {
  createTask,
  uploadVideo,
  uploadTemplate,
  getCalibrationFrames,
  detectCourt,
  saveCorners,
  runTask,
  getTask,
} = require("../../services/analysis");
const { downloadTaskFile } = require("../../services/download");
const { screenToImage, validateCourtQuadrilateral } = require("../../utils/calibration");

const DEFAULT_OPTIONS = {
  pose_family: "yolo-pose",
  pose_mode: "balanced",
  language: "zh",
  audio: true,
  show_skeletons: true,
  show_player_trajectories: true,
  show_court_trajectory: true,
  show_shuttlecock_trajectory: true,
  show_player_stats: true,
  show_pose_roi: true,
  visualize_positions: true,
  yolo_pose_model: "weights/yolo11n-pose.pt",
  ball_model: "weights/yolo11s-ball.pt",
};

const PRESETS = [
  { key: "fast", label: "快速", description: "优先速度，适合预览", pose_mode: "lightweight", visualize_positions: false, factor: [0.5, 1] },
  { key: "standard", label: "标准", description: "速度与精度平衡", pose_mode: "balanced", visualize_positions: true, factor: [1, 2] },
  { key: "precision", label: "高精度", description: "优先识别质量", pose_mode: "performance", visualize_positions: true, factor: [2, 4] },
];

function chooseMedia() {
  return new Promise((resolve, reject) => wx.chooseMedia({
    count: 1,
    mediaType: ["video"],
    sourceType: ["album", "camera"],
    success: resolve,
    fail: reject,
  }));
}

function chooseImage() {
  return new Promise((resolve, reject) => wx.chooseImage({
    count: 1,
    sizeType: ["compressed"],
    sourceType: ["album", "camera"],
    success: resolve,
    fail: reject,
  }));
}

function errorMessage(error, fallback) {
  return (error && (error.errMsg || error.message)) || fallback;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${rest} 秒`;
  return `${minutes} 分 ${rest} 秒`;
}

function fileName(path) {
  return String(path || "比赛视频").split(/[\\/]/).pop() || "比赛视频";
}

function videoDetails(file) {
  return {
    name: fileName(file.tempFilePath),
    sizeLabel: `${((Number(file.size) || 0) / 1024 / 1024).toFixed(1)} MB`,
    durationLabel: formatDuration(file.duration),
    resolutionLabel: file.width && file.height ? `${file.width} × ${file.height}` : "分辨率待识别",
    duration: Number(file.duration) || 0,
  };
}

function estimateLabel(duration, presetKey) {
  if (!duration) return "预计耗时将在读取视频后显示";
  const preset = PRESETS.find((item) => item.key === presetKey) || PRESETS[1];
  const low = Math.max(1, Math.ceil((duration * preset.factor[0]) / 60));
  const high = Math.max(low, Math.ceil((duration * preset.factor[1]) / 60));
  return `预计 ${low}–${high} 分钟，完成后可在任务中心查看`;
}

Page({
  data: {
    videoPath: "",
    videoInfo: null,
    estimateLabel: "",
    templatePath: "",
    taskId: "",
    corners: [],
    manualMode: false,
    isPreparing: false,
    isRunning: false,
    taskStatus: "created",
    progress: 0,
    failureMessage: "",
    templateNaturalWidth: 0,
    templateNaturalHeight: 0,
    calibrationScale: 1,
    preset: "standard",
    presets: PRESETS,
    advancedOpen: false,
    options: DEFAULT_OPTIONS,
    poseFamilies: ["yolo-pose", "rtmpose", "rtmo"],
    poseModes: ["lightweight", "balanced", "performance"],
    languages: ["zh", "en"],
    poseFamilyIndex: 0,
    poseModeIndex: 1,
    languageIndex: 0,
    // 球员选择相关
    playerSelection: null,  // 'upper' | 'lower' | 'skip' | null
    matchResult: null,      // 'win' | 'loss' | 'draw' | null
  },

  async onLoad(options = {}) {
    const taskId = options.task_id || options.taskId;
    if (taskId) await this.resumeTask(taskId);
  },

  async onShow() {
    if (this.data.taskId && ["queued", "running", "uploading", "publishing"].includes(this.data.taskStatus)) {
      await this.pollTask();
      if (this.data.isRunning && !this.pollTimer) this.pollTimer = setInterval(() => this.pollTask(), 2000);
    }
  },

  async resumeTask(taskId) {
    this.setData({ taskId, isPreparing: true, failureMessage: "" });
    try {
      const task = await getTask(taskId);
      const corners = Array.isArray(task.corners) ? task.corners : [];
      this.setData({ corners, taskStatus: task.status, progress: Number(task.progress) || 0 });
      await this.loadCalibrationCandidate(taskId);
      await this.applyTask(task);
    } catch (error) {
      this.setData({ failureMessage: errorMessage(error, "任务恢复失败") });
    } finally {
      this.setData({ isPreparing: false });
    }
  },

  async chooseVideo() {
    try {
      const response = await chooseMedia();
      const file = response.tempFiles && response.tempFiles[0];
      if (file && file.tempFilePath) {
        const info = videoDetails(file);
        this.setData({
          videoPath: file.tempFilePath,
          videoInfo: info,
          estimateLabel: estimateLabel(info.duration, this.data.preset),
          taskId: "",
          templatePath: "",
          corners: [],
          failureMessage: "",
        });
      }
    } catch (error) {
      if (!error || !String(error.errMsg || "").includes("cancel")) {
        this.setData({ failureMessage: errorMessage(error, "视频选择失败") });
      }
    }
  },

  async chooseTemplate() {
    try {
      const response = await chooseImage();
      const path = response.tempFilePaths && response.tempFilePaths[0];
      if (path) this.setData({ templatePath: path, corners: [], manualMode: true, failureMessage: "" });
    } catch (error) {
      if (!error || !String(error.errMsg || "").includes("cancel")) {
        this.setData({ failureMessage: errorMessage(error, "模板选择失败") });
      }
    }
  },

  selectPreset(event) {
    const preset = PRESETS.find((item) => item.key === event.currentTarget.dataset.key) || PRESETS[1];
    this.setData({
      preset: preset.key,
      poseModeIndex: this.data.poseModes.indexOf(preset.pose_mode),
      options: { ...this.data.options, pose_mode: preset.pose_mode, visualize_positions: preset.visualize_positions },
      estimateLabel: estimateLabel(this.data.videoInfo && this.data.videoInfo.duration, preset.key),
    });
  },

  toggleAdvanced() { this.setData({ advancedOpen: !this.data.advancedOpen }); },
  zoomIn() { this.setData({ calibrationScale: Math.min(2, this.data.calibrationScale + 0.25) }); },
  zoomOut() { this.setData({ calibrationScale: Math.max(1, this.data.calibrationScale - 0.25) }); },
  resetZoom() { this.setData({ calibrationScale: 1 }); },

  onPoseFamilyChange(event) {
    const index = Number(event.detail.value);
    this.setData({ poseFamilyIndex: index, options: { ...this.data.options, pose_family: this.data.poseFamilies[index] } });
  },
  onPoseModeChange(event) {
    const index = Number(event.detail.value);
    this.setData({ poseModeIndex: index, options: { ...this.data.options, pose_mode: this.data.poseModes[index] } });
  },
  onLanguageChange(event) {
    const index = Number(event.detail.value);
    this.setData({ languageIndex: index, options: { ...this.data.options, language: this.data.languages[index] } });
  },
  onOptionToggle(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ options: { ...this.data.options, [key]: event.detail.value } });
  },

  // 球员选择
  onSelectPlayer(event) {
    const position = event.currentTarget.dataset.position;
    this.setData({
      playerSelection: position,
      // 如果选择跳过，清除比赛结果
      matchResult: position === 'skip' ? null : this.data.matchResult,
    });
  },

  // 比赛结果选择
  onSelectMatchResult(event) {
    const result = event.currentTarget.dataset.result;
    this.setData({ matchResult: result });
  },

  async loadCalibrationCandidate(taskId) {
    const response = await getCalibrationFrames(taskId);
    const frames = Array.isArray(response) ? response : response.items;
    const frame = Array.isArray(frames) && frames[0];
    if (!frame) return false;
    const path = await downloadTaskFile({ taskId, kind: "calibration", index: Number(frame.index) || 0 });
    this.setData({
      templatePath: path,
      templateNaturalWidth: Number(frame.width) || 0,
      templateNaturalHeight: Number(frame.height) || 0,
      manualMode: false,
    });
    return true;
  },

  async detectCourt() {
    if (!this.data.videoPath) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "请先选择比赛视频", icon: "none" });
      return;
    }
    this.setData({ isPreparing: true, failureMessage: "", corners: [], manualMode: false });
    try {
      const task = this.data.taskId ? { id: this.data.taskId } : await createTask(this.data.options);
      const taskId = task.id;
      this.setData({ taskId });
      await uploadVideo(taskId, this.data.videoPath);
      let hasCandidate = false;
      try {
        hasCandidate = await this.loadCalibrationCandidate(taskId);
      } catch (candidateError) {
        if (!this.data.templatePath) throw candidateError;
      }
      if (!hasCandidate) {
        if (!this.data.templatePath) throw new Error("未能从视频提取校准画面，请选择一张清晰的球场图片重试");
        await uploadTemplate(taskId, this.data.templatePath);
      }
      const detection = await detectCourt(taskId);
      const corners = Array.isArray(detection.corners) ? detection.corners : [];
      if (corners.length === 4) {
        const validation = this.validateCorners(corners);
        if (validation.valid) {
          await saveCorners(taskId, corners);
          this.setData({ corners, manualMode: false, taskStatus: "created" });
        } else {
          this.setData({ corners, manualMode: true, failureMessage: validation.message });
        }
      } else {
        this.setData({ corners: [], manualMode: true, failureMessage: "自动检测未得到四点，请按左上、右上、右下、左下顺序点选" });
      }
    } catch (error) {
      this.setData({ manualMode: Boolean(this.data.templatePath), failureMessage: errorMessage(error, "球场检测失败") });
    } finally {
      this.setData({ isPreparing: false });
    }
  },

  imageViewport(rect) {
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      imageWidth: this.data.templateNaturalWidth || rect.width,
      imageHeight: this.data.templateNaturalHeight || rect.height,
    };
  },

  addCorner(event) {
    if (!this.data.manualMode || this.data.corners.length >= 4) return;
    const append = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || this.data.corners.length >= 4) return;
      this.setData({ corners: [...this.data.corners, [Math.round(x), Math.round(y)]], failureMessage: "" });
    };
    const touch = (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]);
    if (touch && typeof wx.createSelectorQuery === "function") {
      wx.createSelectorQuery().select("#template-preview").boundingClientRect((rect) => {
        if (!rect || !rect.width || !rect.height) return;
        const point = screenToImage({ x: touch.pageX, y: touch.pageY }, this.imageViewport(rect));
        append(point.x, point.y);
      }).exec();
      return;
    }
    append(Number(event.detail && event.detail.x), Number(event.detail && event.detail.y));
  },

  moveCorner(event) {
    const index = Number(event.currentTarget.dataset.index);
    const touch = (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]);
    if (!touch || !Number.isInteger(index) || typeof wx.createSelectorQuery !== "function") return;
    wx.createSelectorQuery().select("#template-preview").boundingClientRect((rect) => {
      if (!rect || !rect.width || !rect.height) return;
      const point = screenToImage({ x: touch.pageX, y: touch.pageY }, this.imageViewport(rect));
      const corners = this.data.corners.slice();
      corners[index] = [point.x, point.y];
      this.setData({ corners, failureMessage: "" });
    }).exec();
  },

  resetCorners() { this.setData({ corners: [], manualMode: true, calibrationScale: 1 }); },
  onTemplateLoad(event) {
    this.setData({
      templateNaturalWidth: Number(event.detail.width) || this.data.templateNaturalWidth,
      templateNaturalHeight: Number(event.detail.height) || this.data.templateNaturalHeight,
    });
  },
  validateCorners(corners = this.data.corners) {
    return validateCourtQuadrilateral(corners, {
      width: this.data.templateNaturalWidth,
      height: this.data.templateNaturalHeight,
    });
  },

  async saveManualCorners() {
    if (!this.data.taskId || this.data.corners.length !== 4) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "请按顺序选择四个角点", icon: "none" });
      return;
    }
    const validation = this.validateCorners();
    if (!validation.valid) {
      this.setData({ failureMessage: validation.message });
      return;
    }
    try {
      await saveCorners(this.data.taskId, this.data.corners);
      this.setData({ failureMessage: "" });
      if (typeof wx.showToast === "function") wx.showToast({ title: "角点已保存", icon: "success" });
    } catch (error) {
      this.setData({ failureMessage: errorMessage(error, "角点保存失败") });
    }
  },

  async startAnalysis() {
    if (!this.data.taskId || this.data.corners.length !== 4) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "请先完成球场四点校正", icon: "none" });
      return;
    }
    if (!this.data.playerSelection) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "请先确定球员", icon: "none" });
      return;
    }
    if (this.data.playerSelection !== "skip" && !this.data.matchResult) {
      if (typeof wx.showToast === "function") wx.showToast({ title: "请选择比赛结果", icon: "none" });
      return;
    }
    const validation = this.validateCorners();
    if (!validation.valid) {
      this.setData({ failureMessage: validation.message });
      return;
    }
    this.clearPolling();
    this.setData({ isRunning: true, failureMessage: "", taskStatus: "queued", progress: 0 });
    try {
      await saveCorners(this.data.taskId, this.data.corners);
      // 传递球员选择和比赛结果
      await runTask(this.data.taskId, this.data.playerSelection, this.data.matchResult);
      this.pollTimer = setInterval(() => this.pollTask(), 2000);
    } catch (error) {
      this.setData({ isRunning: false, failureMessage: errorMessage(error, "分析启动失败") });
    }
  },

  async pollTask() {
    try {
      const task = await getTask(this.data.taskId);
      await this.applyTask(task);
    } catch (error) {
      this.clearPolling();
      this.setData({ isRunning: false, failureMessage: errorMessage(error, "任务状态获取失败") });
    }
  },
  async applyTask(task) {
    const terminal = ["succeeded", "failed", "cancelled"].includes(task.status);
    const active = ["uploading", "queued", "running", "publishing"].includes(task.status);
    this.setData({
      taskStatus: task.status,
      progress: Number(task.progress) || 0,
      failureMessage: task.error_message || task.recovery_hint || "",
      isRunning: active,
    });
    if (terminal) this.clearPolling();
    if (task.status === "succeeded" && !this.resultOpened) {
      this.resultOpened = true;
      wx.navigateTo({ url: `/pages/result/index?task_id=${this.data.taskId}` });
    }
  },
  clearPolling() {
    if (this.pollTimer !== undefined && this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  },
  onHide() { this.clearPolling(); },
  onUnload() { this.clearPolling(); },
});
