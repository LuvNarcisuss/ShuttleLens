# Findings & Decisions

## Requirements

- 将 WebUI 的上传、球场检测、参数配置、分析和结果查看完整迁移至小程序与后端接口。
- 小程序底部仅有首页和个人两个标签。
- 个人页显示头像、昵称及任务历史。
- 当前目标是本地开发，采用单进程后台任务。

## Research Findings

- `webui/app.py` 的核心执行入口为 `run_full_analysis`，依赖 `webui.pipeline.prepare_court` 和 `run_analysis`。
- `run_analysis` 需要视频路径、模板路径、四角点、选项和可选进度回调，返回视频、元数据、检测数据与图片路径。
- 后端现有 FastAPI 路由仅包含 `/api/auth`，使用 SQLAlchemy、Alembic 和 Bearer Token。
- 小程序已具备 `request` 服务、令牌存储和微信资料登录，当前只有 `pages/home`。

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 复用 Python 分析管线 | 避免改变已存在的 CV 推理、视频输出和图表生成逻辑。 |
| 结果通过鉴权文件接口提供 | 避免暴露本地绝对文件路径或任意静态目录。 |
| 使用 2 秒轮询 | 不需要 WebSocket，适合本地单任务状态更新。 |
| 将 run_analysis 输出关联到任务目录 | 原有函数使用时间戳 WebUI 目录，任务服务需要只存储可控的任务相对结果路径。 |
| 两阶段上传 | 先创建草稿任务，再通过两个单文件上传接口顺序上传视频和模板。 |

## Issues Encountered

| Issue | Resolution |
|-------|------------|
| 现有小程序 API 地址指向 127.0.0.1 | 计划中将改为可配置的局域网 API 基地址。 |
| 单请求双文件上传与 wx.uploadFile 不匹配 | 已确认改用草稿任务加两个单文件上传接口。 |

## Resources

- `webui/app.py`
- `backend/app/api/auth.py`
- `backend/app/db/models/user.py`
- `wx_app/miniprogram/pages/home/`

## Visual/Browser Findings

- 未使用浏览器或图像分析；WebUI 源码显示左栏输入和设置、右栏球场检测与结果展示的两栏工作流。
