# Product Experience Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成计划 5.6–5.10，使用户可通过单视频创建可恢复任务，并获得结构化仪表盘、回合时间轴、精彩片段以及受控导出分享能力。

**Architecture:** 分析完成时从统一检测 JSONL 生成结构化 `analytics.json` 与导出产物，任务服务负责状态、归档和访问控制，小程序与 WebUI 只消费受控 API。任务中心使用游标分页与软删除，候选校准帧由上传视频自动抽取。

**Tech Stack:** Python 3.11+、FastAPI、SQLAlchemy 2、Alembic、Pydantic 2、OpenCV、原生微信小程序 JavaScript/WXML/WXSS、Node test runner、pytest。

## Global Constraints

- 本轮只完成本地功能与自动化验证，不部署、发布或执行 `git push`。
- 删除采用软删除，不能物理删除用户媒体。
- 分享令牌必须有有效期、可撤销且只保存哈希。
- 所有指标由同一结构化结果复算；不可用的击球往返次数必须为 `null` 并显示原因。
- 保持历史任务兼容，不泄露服务器绝对路径。
- 小程序仍使用原生组件和现有 CommonJS 服务结构，不引入新的 UI 组件库。

---

### Task 1: 结构化复盘分析器

**Files:**
- Create: `badminton_analysis/analysis/match_summary.py`
- Create: `tests/test_match_summary.py`
- Modify: `badminton_analysis/analysis/__init__.py`
- Modify: `webui/pipeline.py`
- Modify: `backend/app/services/analysis_tasks.py`
- Test: `tests/test_match_summary.py`
- Test: `backend/tests/test_analysis_task_service.py`

**Interfaces:**
- Consumes: `build_match_analytics(detections_path: str | Path, metadata_path: str | Path) -> dict[str, Any]`
- Produces: `write_analysis_artifacts(detections_path, metadata_path, output_dir) -> dict[str, str]`，返回 `analytics`、`highlights`、`summary_csv`、`report` 路径。

- [ ] **Step 1: 写入失败测试，固定回合、移动和区域统计契约**

```python
def test_build_match_analytics_has_recomputable_metrics(tmp_path):
    detections = write_detection_fixture(tmp_path, frames=[1, 2, 3, 205, 206, 207])
    metadata = write_metadata_fixture(tmp_path, fps=10, total_frames=300)
    result = build_match_analytics(detections, metadata, min_rally_frames=3)
    assert result["match"]["duration_sec"]["value"] == 30.0
    assert result["match"]["rally_count"]["value"] == 2
    assert result["rallies"][0]["start_sec"] == 0.1
    assert result["players"]["upper"]["zones"]["front"] >= 0
    assert result["quality"]["confidence"] in {"low", "medium", "high"}
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `python -m pytest tests/test_match_summary.py -q`
Expected: FAIL，提示 `badminton_analysis.analysis.match_summary` 不存在。

- [ ] **Step 3: 实现纯函数分析器与可信度模型**

```python
def build_match_analytics(
    detections_path: str | Path,
    metadata_path: str | Path,
    *,
    rally_gap_frames: int = 100,
    min_rally_frames: int = 150,
) -> dict[str, Any]:
    records = load_detection_records(detections_path)
    video = load_video_metadata(metadata_path)
    rallies = segment_rallies(records, video["fps"], rally_gap_frames, min_rally_frames)
    return compose_analytics(video, records, rallies)
```

移动统计复用当前 5 帧采样、0.05 米噪声阈值和 8 米/秒异常速度上限；区域按标准球场坐标计算，比例总和在有效样本存在时为 1。

- [ ] **Step 4: 增加精彩推荐和四类导出产物测试**

```python
def test_write_analysis_artifacts_explains_highlights(tmp_path):
    paths = write_analysis_artifacts(detections, metadata, tmp_path)
    highlights = json.loads(Path(paths["highlights"]).read_text("utf-8"))
    assert highlights["items"][0]["source"] == "system_recommended"
    assert highlights["items"][0]["reasons"]
    assert highlights["items"][0]["rally_count"] is None
    assert Path(paths["summary_csv"]).is_file()
    assert Path(paths["report"]).is_file()
```

- [ ] **Step 5: 实现 `write_analysis_artifacts` 并接入流水线归档**

```python
artifact_paths = write_analysis_artifacts(
    system.detections_path,
    system.metadata_path,
    output_dir,
)
result.update(artifact_paths)
```

`AnalysisTaskService._store_result` 必须把四个新增路径转换为任务存储根目录下的相对路径。

- [ ] **Step 6: 运行分析与任务归档测试**

Run: `python -m pytest tests/test_match_summary.py backend/tests/test_analysis_task_service.py -q`
Expected: PASS。

- [ ] **Step 7: 提交本任务文件**

```bash
git add badminton_analysis/analysis tests/test_match_summary.py webui/pipeline.py backend/app/services/analysis_tasks.py backend/tests/test_analysis_task_service.py
git commit -m "feat: generate structured match analytics"
```

### Task 2: 任务模型、稳定分页与恢复操作

**Files:**
- Create: `backend/alembic/versions/005_product_task_fields.py`
- Modify: `backend/app/db/models/analysis_task.py`
- Modify: `backend/app/schemas/analysis.py`
- Modify: `backend/app/services/analysis_tasks.py`
- Modify: `backend/app/api/analysis.py`
- Modify: `backend/tests/api/test_analysis.py`
- Modify: `backend/tests/test_analysis_schema.py`

**Interfaces:**
- Produces: `GET /api/analysis/tasks?status=&cursor=&limit=` → `{items, next_cursor}`。
- Produces: `PATCH /tasks/{id}`、`POST /tasks/{id}/cancel`、`POST /tasks/{id}/retry`、`POST /tasks/{id}/reanalyze`、`DELETE /tasks/{id}`。

- [ ] **Step 1: 写入模型、游标分页和筛选失败测试**

```python
def test_task_list_uses_stable_cursor_and_status_filter(api_context):
    first = api_context.client.get("/api/analysis/tasks?status=succeeded&limit=2").json()
    second = api_context.client.get(
        "/api/analysis/tasks", params={"status": "succeeded", "limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert not ({item["id"] for item in first["items"]} & {item["id"] for item in second["items"]})
```

- [ ] **Step 2: 写入取消、重试、重新分析和软删除失败测试**

```python
def test_task_recovery_actions_preserve_source_and_media(api_context):
    cancelled = client.post(f"/api/analysis/tasks/{queued.id}/cancel")
    retried = client.post(f"/api/analysis/tasks/{failed.id}/retry")
    draft = client.post(f"/api/analysis/tasks/{failed.id}/reanalyze")
    deleted = client.delete(f"/api/analysis/tasks/{failed.id}")
    assert cancelled.json()["status"] == "cancelled"
    assert retried.json()["source_task_id"] == str(failed.id)
    assert draft.json()["status"] == "created"
    assert deleted.status_code == 204
    assert client.get(f"/api/analysis/tasks/{failed.id}").status_code == 404
```

- [ ] **Step 3: 运行失败测试**

Run: `python -m pytest backend/tests/api/test_analysis.py backend/tests/test_analysis_schema.py -q`
Expected: FAIL，缺少新增字段、响应和路由。

- [ ] **Step 4: 新增迁移和 ORM 字段**

```python
name = mapped_column(String(160), default="", nullable=False)
cover_path = mapped_column(String(1024), nullable=True)
video_metadata_json = mapped_column(JSON, default=dict, nullable=False)
stage = mapped_column(String(32), default="draft", nullable=False)
deleted_at = mapped_column(DateTime(timezone=True), nullable=True, index=True)
source_task_id = mapped_column(ForeignKey("analysis_tasks.id"), nullable=True)
```

- [ ] **Step 5: 实现严格游标编码与查询**

```python
import base64
import json

class TaskCursor(BaseModel):
    created_at: datetime
    id: UUID

def encode_cursor(created_at: datetime, task_id: UUID) -> str:
    payload = json.dumps({"created_at": created_at.isoformat(), "id": str(task_id)})
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")

def decode_cursor(value: str) -> TaskCursor:
    padded = value + "=" * (-len(value) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    return TaskCursor.model_validate(payload)
```

查询顺序固定为 `created_at DESC, id DESC`，游标条件使用二元组严格小于，`limit` 限制为 1–50。

- [ ] **Step 6: 实现任务操作的状态约束**

```python
def cancel(task_id: UUID, user_id: UUID) -> AnalysisTask:
    """将 created/uploading/queued 任务转换为 cancelled。"""

def retry(task_id: UUID, user_id: UUID) -> AnalysisTask:
    """从 failed 任务复制输入、校准和参数，创建并入队新任务。"""

def reanalyze(task_id: UUID, user_id: UUID) -> AnalysisTask:
    """从终态任务复制输入和校准，创建可编辑草稿。"""

def soft_delete(task_id: UUID, user_id: UUID) -> None:
    """设置 deleted_at；不删除数据库记录和任何媒体文件。"""
```

复制媒体时使用任务私有目录中的新文件，不能让两个任务共享可被未来清理的路径。

- [ ] **Step 7: 运行后端任务测试**

Run: `python -m pytest backend/tests/api/test_analysis.py backend/tests/test_analysis_task_service.py backend/tests/test_analysis_schema.py -q`
Expected: PASS。

- [ ] **Step 8: 提交本任务文件**

```bash
git add backend/alembic backend/app backend/tests
git commit -m "feat: add recoverable task center api"
```

### Task 3: 单视频元数据与候选校准帧

**Files:**
- Create: `backend/app/services/video_preparation.py`
- Modify: `backend/app/services/analysis_tasks.py`
- Modify: `backend/app/api/analysis.py`
- Modify: `backend/app/schemas/analysis.py`
- Modify: `backend/tests/api/test_analysis.py`
- Create: `backend/tests/test_video_preparation.py`

**Interfaces:**
- Produces: `probe_video(path) -> VideoMetadata`。
- Produces: `extract_calibration_frames(path, destination, count=3) -> list[CalibrationFrame]`。
- Produces: `GET /tasks/{id}/calibration-frames` 和受控封面/候选帧文件接口。

- [ ] **Step 1: 写入视频探测与候选帧失败测试**

```python
def test_extract_frames_reports_original_dimensions(sample_video, tmp_path):
    metadata = probe_video(sample_video)
    frames = extract_calibration_frames(sample_video, tmp_path, count=3)
    assert metadata.width > metadata.height
    assert metadata.duration_sec > 0
    assert 1 <= len(frames) <= 3
    assert all(frame.width == metadata.width for frame in frames)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest backend/tests/test_video_preparation.py -q`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 OpenCV 探测与均匀候选帧抽取**

```python
@dataclass(frozen=True)
class VideoMetadata:
    filename: str
    size_bytes: int
    duration_sec: float
    width: int
    height: int
    fps: float

@dataclass(frozen=True)
class CalibrationFrame:
    path: Path
    timestamp_sec: float
    width: int
    height: int
```

`extract_calibration_frames(video_path: Path, destination: Path, count: int = 3) -> list[CalibrationFrame]` 打开视频一次，按 `[5%, 35%, 65%]` 时点读取最多三帧并以 JPEG 写入 `destination`；无法读取的时点跳过。

候选时间点覆盖前段和均匀区间，读取失败的帧跳过；全部失败时返回稳定错误码 `VIDEO_FRAME_EXTRACTION_FAILED`。

- [ ] **Step 4: 视频上传后保存元数据、候选帧和默认封面**

```python
task.video_metadata_json = metadata.to_dict()
task.cover_path = relative_frames[0]
task.template_path = relative_frames[0]
task.stage = "calibration"
```

- [ ] **Step 5: 增加所有权和路径安全 API 测试并运行**

Run: `python -m pytest backend/tests/test_video_preparation.py backend/tests/api/test_analysis.py -q`
Expected: PASS，非所有者 404，响应不含绝对路径。

- [ ] **Step 6: 提交本任务文件**

```bash
git add backend/app backend/tests
git commit -m "feat: prepare calibration frames from video"
```

### Task 4: 小程序任务中心与恢复生命周期

**Files:**
- Create: `wx_app/miniprogram/pages/tasks/index.js`
- Create: `wx_app/miniprogram/pages/tasks/index.wxml`
- Create: `wx_app/miniprogram/pages/tasks/index.wxss`
- Create: `wx_app/miniprogram/pages/tasks/index.json`
- Create: `wx_app/tests/pages/tasks-runtime.test.js`
- Modify: `wx_app/miniprogram/app.json`
- Modify: `wx_app/miniprogram/services/analysis.js`
- Modify: `wx_app/tests/services/analysis.test.js`

**Interfaces:**
- Consumes: Task 2 游标 API 与恢复操作。
- Produces: `loadFirstPage()`、`loadNextPage()`、`refreshTasks()`、`startPolling()`、`stopPolling()` 页面方法。

- [ ] **Step 1: 写入服务和页面生命周期失败测试**

```javascript
test("tasks page restores on show and stops polling while hidden", async () => {
  await page.onShow();
  assert.equal(calls.filter((x) => x === "list").length, 1);
  page.onHide();
  assert.deepEqual(cleared, [timerId]);
  await page.onShow();
  assert.equal(calls.filter((x) => x === "list").length, 2);
});
```

- [ ] **Step 2: 写入稳定翻页、状态筛选、下拉刷新和操作失败测试**

```javascript
assert.deepEqual(listCalls[1], { status: "failed", cursor: "cursor-1", limit: 20 });
await page.onPullDownRefresh();
assert.equal(page.data.nextCursor, "cursor-refreshed");
```

- [ ] **Step 3: 运行小程序测试确认失败**

Run: `cd wx_app && npm test -- tests/pages/tasks-runtime.test.js tests/services/analysis.test.js`
Expected: FAIL，页面和客户端方法不存在。

- [ ] **Step 4: 扩展 analysis client**

```javascript
listTasks({ status = "", cursor = "", limit = 20 } = {}) { ... }
renameTask(taskId, name) { ... }
cancelTask(taskId) { ... }
retryTask(taskId) { ... }
reanalyzeTask(taskId) { ... }
deleteTask(taskId) { ... }
```

- [ ] **Step 5: 实现任务中心页面和两标签导航**

`app.json` 首个 tab 改为 `pages/tasks/index`，分析页保留为普通路由。卡片操作按后端返回状态渲染，失败原因和恢复建议必须分开展示。

- [ ] **Step 6: 运行小程序任务中心测试**

Run: `cd wx_app && npm test -- tests/pages/tasks-runtime.test.js tests/services/analysis.test.js tests/pages/tabbar.test.js`
Expected: PASS。

- [ ] **Step 7: 提交本任务文件**

```bash
git add wx_app/miniprogram wx_app/tests
git commit -m "feat: add recoverable mini program task center"
```

### Task 5: 小程序单视频校准流程

**Files:**
- Create: `wx_app/miniprogram/utils/calibration.js`
- Create: `wx_app/tests/utils/calibration.test.js`
- Modify: `wx_app/miniprogram/pages/analyze/index.js`
- Modify: `wx_app/miniprogram/pages/analyze/index.wxml`
- Modify: `wx_app/miniprogram/pages/analyze/index.wxss`
- Modify: `wx_app/miniprogram/services/analysis.js`
- Modify: `wx_app/tests/pages/analyze-runtime.test.js`

**Interfaces:**
- Consumes: Task 3 候选帧 API。
- Produces: `screenToImage(point, viewport, transform) -> {x, y}`、`isValidCourtQuadrilateral(points, imageSize) -> ValidationResult`。

- [ ] **Step 1: 写入坐标误差和四边形校验失败测试**

```javascript
test("screen mapping stays within one source pixel", () => {
  const point = screenToImage({ x: 187.25, y: 305.5 }, viewport, transform);
  assert.ok(Math.abs(point.x - expected.x) <= 1);
  assert.ok(Math.abs(point.y - expected.y) <= 1);
});

test("crossed and near-zero-area courts are rejected", () => {
  assert.equal(isValidCourtQuadrilateral(crossed, imageSize).valid, false);
  assert.equal(isValidCourtQuadrilateral(tiny, imageSize).valid, false);
});
```

- [ ] **Step 2: 运行校准测试确认失败**

Run: `cd wx_app && npm test -- tests/utils/calibration.test.js tests/pages/analyze-runtime.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现纯坐标工具和档位映射**

```javascript
const PRESETS = {
  fast: { pose_family: "yolo-pose", pose_mode: "lightweight", visualize_positions: true },
  standard: { pose_family: "yolo-pose", pose_mode: "balanced", visualize_positions: true },
  precision: { pose_family: "rtmpose", pose_mode: "performance", visualize_positions: true },
};
```

- [ ] **Step 4: 将上传流程改为单视频与候选帧**

选择视频后展示 `name/size/duration/width/height` 和档位估算；上传完成后加载候选帧并自动检测球场。仅在候选帧失败时显示兼容的手动模板入口。

- [ ] **Step 5: 实现角点拖拽、缩放、重置和合法性文案**

拖拽事件只更新目标角点；缩放与偏移不修改原图坐标。保存前必须调用 `isValidCourtQuadrilateral`，错误时显示具体原因。

- [ ] **Step 6: 运行分析页与坐标测试**

Run: `cd wx_app && npm test -- tests/utils/calibration.test.js tests/pages/analyze-runtime.test.js`
Expected: PASS。

- [ ] **Step 7: 提交本任务文件**

```bash
git add wx_app/miniprogram/pages/analyze wx_app/miniprogram/utils wx_app/miniprogram/services/analysis.js wx_app/tests
git commit -m "feat: simplify video calibration flow"
```

### Task 6: 结果仪表盘、时间轴与精彩片段

**Files:**
- Modify: `backend/app/api/analysis.py`
- Modify: `backend/app/schemas/analysis.py`
- Modify: `backend/tests/api/test_analysis.py`
- Modify: `wx_app/miniprogram/services/result.js`
- Modify: `wx_app/miniprogram/pages/result/index.js`
- Modify: `wx_app/miniprogram/pages/result/index.wxml`
- Modify: `wx_app/miniprogram/pages/result/index.wxss`
- Modify: `wx_app/tests/pages/result-runtime.test.js`
- Modify: `wx_app/tests/services/result.test.js`

**Interfaces:**
- Produces: `GET /tasks/{id}/analytics` 和 `PUT /tasks/{id}/highlights/{highlight_id}`。
- Consumes: Task 1 的 `analytics.json` 和 `highlights.json`。

- [ ] **Step 1: 写入结构化资源与精彩片段编辑 API 失败测试**

```python
def test_analytics_is_owned_and_highlight_range_is_valid(api_context):
    assert owner.get(f"/tasks/{task.id}/analytics").status_code == 200
    assert other.get(f"/tasks/{task.id}/analytics").status_code == 404
    invalid = owner.put(f"/tasks/{task.id}/highlights/h1", json={"start_sec": 8, "end_sec": 4})
    assert invalid.status_code == 422
```

- [ ] **Step 2: 写入小程序仪表盘切换、跳转和编辑失败测试**

```javascript
page.selectScope({ currentTarget: { dataset: { scope: "rally", rallyId: "r1" } } });
page.seekRally({ currentTarget: { dataset: { start: 12.4 } } });
assert.deepEqual(videoCalls, [["seek", 12.4]]);
assert.equal(page.data.selectedScope, "rally");
```

- [ ] **Step 3: 运行失败测试**

Run: `python -m pytest backend/tests/api/test_analysis.py -q`
Run: `cd wx_app && npm test -- tests/pages/result-runtime.test.js tests/services/result.test.js`
Expected: FAIL。

- [ ] **Step 4: 实现后端结构化结果读取和精彩片段校验**

读取仅允许任务归档目录下的 JSON；编辑结果保存为用户覆盖层，不直接改写系统推荐原值，并验证视频范围。

- [ ] **Step 5: 实现结果页三个统计维度和指标说明**

每个指标展示值、单位、来源和可信度；`available=false` 时展示原因。球员选择为上场/下场，回合选择使用稳定回合 ID。

- [ ] **Step 6: 实现时间轴、视频跳转、推荐说明与调整控件**

```javascript
seekRally(event) {
  const start = Number(event.currentTarget.dataset.start);
  if (this.videoContext && Number.isFinite(start)) this.videoContext.seek(start);
}
```

- [ ] **Step 7: 运行后端与小程序结果测试**

Run: `python -m pytest backend/tests/api/test_analysis.py -q`
Run: `cd wx_app && npm test -- tests/pages/result-runtime.test.js tests/services/result.test.js`
Expected: PASS。

- [ ] **Step 8: 提交本任务文件**

```bash
git add backend/app backend/tests wx_app/miniprogram wx_app/tests
git commit -m "feat: add match dashboard and rally timeline"
```

### Task 7: 精彩片段、Web 导出与受控分享

**Files:**
- Create: `backend/app/db/models/share_token.py`
- Create: `backend/alembic/versions/006_create_share_tokens.py`
- Create: `backend/app/services/sharing.py`
- Modify: `backend/app/db/models/__init__.py`
- Modify: `backend/app/api/analysis.py`
- Modify: `backend/app/schemas/analysis.py`
- Modify: `backend/tests/api/test_analysis.py`
- Modify: `webui/app.py`
- Create: `tests/test_webui_exports.py`
- Modify: `wx_app/miniprogram/services/download.js`
- Modify: `wx_app/miniprogram/pages/result/index.js`
- Modify: `wx_app/tests/pages/result-runtime.test.js`

**Interfaces:**
- Produces: `POST /tasks/{id}/highlights/{highlight_id}/clip`、`POST /tasks/{id}/shares`、`DELETE /tasks/{id}/shares/{share_id}`、`GET /shares/{token}/{kind}`。
- Consumes: Task 1 导出文件与 Task 6 用户精彩片段覆盖层。

- [ ] **Step 1: 写入分享权限、过期和撤销失败测试**

```python
def test_share_token_expires_and_can_be_revoked(api_context, freezer):
    created = owner.post(f"/tasks/{task.id}/shares", json={"kind": "report", "ttl_seconds": 60}).json()
    assert anonymous.get(created["path"]).status_code == 200
    freezer.tick(61)
    assert anonymous.get(created["path"]).status_code == 410
```

- [ ] **Step 2: 写入片段边界和 WebUI 导出失败测试**

```python
def test_webui_result_exposes_csv_jsonl_and_report_files(result_fixture):
    outputs = present_result_files(result_fixture)
    assert set(outputs) >= {"summary_csv", "detections", "report"}
```

- [ ] **Step 3: 运行失败测试**

Run: `python -m pytest backend/tests/api/test_analysis.py tests/test_webui_exports.py -q`
Expected: FAIL。

- [ ] **Step 4: 实现哈希分享令牌和受控公开读取**

```python
raw_token = secrets.token_urlsafe(32)
token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
```

TTL 限制为 60 秒到 7 天；数据库不保存原始令牌。软删除任务、撤销令牌和过期令牌分别返回不可访问状态。

- [ ] **Step 5: 实现精彩片段裁剪和私有下载**

调用现有 ffmpeg 查找逻辑，以开始/结束秒裁剪已归档结果视频；输出留在任务目录，校验请求范围和任务所有权。

- [ ] **Step 6: 在 WebUI 暴露三类导出文件，在小程序增加片段保存**

WebUI 只返回真实存在的路径；小程序通过认证下载接口保存片段，并沿用相册权限恢复逻辑。

- [ ] **Step 7: 运行功能测试**

Run: `python -m pytest backend/tests/api/test_analysis.py tests/test_webui_exports.py -q`
Run: `cd wx_app && npm test -- tests/pages/result-runtime.test.js tests/services/download.test.js`
Expected: PASS。

- [ ] **Step 8: 提交本任务文件**

```bash
git add backend webui/app.py tests/test_webui_exports.py wx_app/miniprogram wx_app/tests
git commit -m "feat: add controlled exports and sharing"
```

### Task 8: 完整回归与验收审计

**Files:**
- Modify only files required to correct failures introduced by Tasks 1–7.

**Interfaces:**
- Consumes: 所有前序任务产物。
- Produces: 自动化验收证据与仍需微信开发者工具验证的清单。

- [ ] **Step 1: 运行后端与分析测试全集**

Run: `python -m pytest backend/tests tests -q`
Expected: PASS；若 GPU 模型测试被显式跳过，记录跳过原因。

- [ ] **Step 2: 运行小程序测试与类型检查**

Run: `cd wx_app && npm test`
Run: `cd wx_app && npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 验证迁移链和工作树范围**

Run: `cd backend && python -m alembic heads`
Expected: 单一 head 为 `006`。
Run: `git diff --check`
Expected: 无错误。

- [ ] **Step 4: 按 5.6–5.10 逐项审计证据**

检查每项需求是否有实现文件、针对性测试和通过输出；微信媒体选择、双指缩放、真机视频跳转及相册权限标为需要开发者工具/真机手动验证，不得用 Node 测试代替。

- [ ] **Step 5: 提交最终修复**

先用 `git status --short` 列出 Task 8 实际修复文件，再逐个使用 `git add path/to/file` 暂存；不得使用目录级暂存或包含用户原有改动。确认暂存差异后运行 `git commit -m "test: verify product experience features"`。
