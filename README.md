# Good-Badminton

本仓库基于 [yo-WASSUP/Good-Badminton](https://github.com/yo-WASSUP/Good-Badminton) 开源项目改造。原项目提供羽毛球视频分析能力；本仓库在此基础上增加了 FastAPI 后端、MySQL 数据库和微信小程序，形成从移动端登录、提交分析任务到查看结果的完整流程。

仓库提供三种使用方式：

- 命令行（CLI）：适合本地批处理、参数调试和算法研究。
- Gradio WebUI：适合在浏览器中上传视频、校准球场并查看结果。
- 微信小程序：通过 FastAPI 和 MySQL 提供登录、任务管理、结果播放与相册保存。

项目仍在开发中。击球点识别、羽毛球小目标检测和复杂镜头下的稳定性还有改进空间，当前版本更适合固定机位的比赛视频、研究实验和二次开发。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## 项目来源与扩展

视频分析算法、模型接入、CLI 和 Gradio WebUI 来自原 Good-Badminton 项目及其贡献者。本仓库主要增加了以下内容：

- 使用 FastAPI、SQLAlchemy、Alembic 和 MySQL 构建服务端。
- 增加微信身份登录、手机号绑定、头像昵称和 JWT 鉴权。
- 将视频分析封装为带状态和进度的用户任务。
- 增加原生微信小程序，支持上传、球场校准、历史任务和结果查看。
- 增加结果文件鉴权下载、横屏播放、图表预览和保存相册。
- 提供 Docker Compose 开发环境和后端、小程序自动化测试。

本仓库是对上游开源项目的衍生开发，不代表上游作者维护的其他项目。

## 功能

- 支持 RTMPose、RTMO 和 Ultralytics YOLO Pose。
- 使用 YOLO 模型检测羽毛球并绘制运动轨迹。
- 自动检测球场边界，失败时可以手动标注四个角点。
- 将球员位置映射到标准羽毛球场坐标。
- 记录球员移动轨迹、距离、速度和回合信息。
- 输出带骨架、轨迹和统计叠加层的 MP4 视频。
- 生成球员位置热力图和散点图。
- 导出 `metadata.json` 与逐帧 `detections.jsonl`。
- 支持中英文可视化文字。
- 提供浏览器界面和微信小程序客户端。

## 选择使用方式

| 使用方式 | 适合场景 | 入口 |
| --- | --- | --- |
| CLI | 本地分析、脚本调用、完整参数控制 | `python main.py` |
| WebUI | 浏览器上传、可视化球场校准 | `python -m webui.app` |
| 微信小程序 | 移动端任务提交、历史结果与相册保存 | `wx_app/` + `backend/` |

如果只是想在本机处理一个视频，建议先使用 CLI。希望减少命令行操作时使用 WebUI。微信小程序需要额外准备 MySQL、后端服务和微信公众平台配置。

## 环境要求

- Python 3.10 或更高版本
- FFmpeg，并已加入系统 `PATH`
- 建议使用 16 GB 以上内存和 SSD
- 建议使用 NVIDIA GPU，6 GB 以上显存更适合较高分辨率视频

根目录的 `requirements.txt` 当前固定使用 PyTorch 2.5.1、CUDA 12.1 wheel 和 `onnxruntime-gpu`。安装前请确认 NVIDIA 驱动可用：

```bash
nvidia-smi
```

CPU 也可以运行核心分析流程，但速度会明显降低。CPU 环境需要自行换用 PyTorch CPU wheel 和 `onnxruntime`，不要同时安装 CPU 与 GPU 版 ONNX Runtime。

## 安装

下载或克隆本仓库后，在项目根目录创建虚拟环境：

```bash
cd Good-Badminton
python -m venv .venv
```

Windows PowerShell：

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Linux 或 macOS：

```bash
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

仓库已经包含默认模型：

```text
weights/yolo11n-pose.pt
weights/yolo11s-ball.pt
weights/yolo26n-pose.pt
```

如需替换模型，可以通过 CLI 参数或 WebUI 高级选项指定文件路径。

## 使用 CLI

最短命令：

```bash
python main.py --video-path videos/demo.mp4
```

如果没有提供 `--template-path`，程序会打开文件选择器，让你选择一张球场模板图。模板图应来自同一视频，尽量选择视角稳定、球场线清楚且遮挡较少的画面。

程序会先尝试自动检测球场边界。自动结果不合适时，可以按界面提示进入手动标注，并依次点击：

```text
左上 → 右上 → 右下 → 左下
```

带模板图和常用参数的示例：

```bash
python main.py \
  --video-path videos/demo.mp4 \
  --template-path templates/court.png \
  --pose-family yolo-pose \
  --yolo-pose-model weights/yolo11n-pose.pt \
  --ball-model weights/yolo11s-ball.pt \
  --language zh
```

姿态模型选择：

| 参数 | 说明 |
| --- | --- |
| `--pose-family rtmpose` | 两阶段姿态检测，可配合不同 `pose-mode` |
| `--pose-family rtmo` | 一阶段姿态检测，侧重速度 |
| `--pose-family yolo-pose` | 使用 Ultralytics YOLO Pose |

常用开关包括：

```text
--display true|false
--skeletons true|false
--player-trajectories true|false
--court-trajectory true|false
--shuttlecock-trajectory true|false
--player-stats true|false
--visualize-positions true|false
--audio true|false
--performance-stats
```

查看完整参数：

```bash
python main.py --help
```

## 使用 WebUI

根目录依赖已经包含 Gradio。安装完成后，在仓库根目录运行：

```bash
python -m webui.app
```

打开终端显示的本地地址，通常为 `http://127.0.0.1:7860`。操作顺序如下：

1. 上传比赛视频和球场模板图。
2. 点击“检测球场”。
3. 自动检测失败或结果不准确时，在预览图中依次点击四个角点，然后应用手动角点。
4. 选择姿态模型、语言和可视化选项。
5. 运行分析，等待处理完成。
6. 查看或下载结果视频、图表、元数据和 JSONL 检测数据。

WebUI 对单个视频限制为 2 GB，对模板图限制为 50 MB。同一进程默认只并发执行一个分析任务。

## 微信小程序与后端

微信小程序不是独立的离线客户端。完整链路由以下部分组成：

```text
微信小程序 wx_app/
        ↓ HTTP + Bearer token
FastAPI backend/
        ↓
MySQL + 分析任务存储
        ↓
Good-Badminton 视频分析流程
```

小程序目前支持：

- 微信身份登录、首次手机号绑定和头像昵称填写。
- 个人资料及脱敏手机号展示。
- 视频与球场模板上传、自动或手动角点校准。
- 分析任务创建、进度查询和历史任务查看。
- 独立结果页、90 度横屏全屏播放和图表预览。
- 鉴权下载、下载进度、视频或单张图表保存到系统相册。
- 相册权限被拒绝后，由用户主动进入设置恢复。

### 使用 Docker 启动开发后端

`infra/docker-compose.yml` 会启动 MySQL、Redis 和 API：

```bash
docker compose -f infra/docker-compose.yml up --build
```

API 默认监听 `http://127.0.0.1:8000`，健康检查地址为：

```text
http://127.0.0.1:8000/healthz
```

Compose 配置使用 `WECHAT_AUTH_MODE=mock`，只能用于本地开发和自动化测试。

### 本地启动后端

在已有 MySQL 的情况下：

```bash
cd backend
pip install -e ".[dev]"
```

根据 `backend/.env.example` 创建 `backend/.env`，至少配置：

```dotenv
DATABASE_URL=mysql+pymysql://<user>:<password>@127.0.0.1:3306/good_badminton
JWT_SECRET=<development-secret>
WECHAT_AUTH_MODE=mock
```

执行迁移并启动 API：

```bash
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 导入小程序

1. 使用微信开发者工具导入 `wx_app/`。
2. `miniprogramRoot` 已配置为 `miniprogram/`。
3. 开发环境可在调试控制台设置 API 地址：

```javascript
wx.setStorageSync("api_base_url", "http://127.0.0.1:8000/api")
```

4. 编译并检查登录、分析和个人中心页面。

本地回环地址只适用于开发者工具。真机调试需要手机能够访问后端，并满足微信小程序的合法域名要求。

### 生产环境要求

生产环境至少需要配置：

```dotenv
APP_ENV=production
WECHAT_AUTH_MODE=live
WECHAT_APP_ID=<production-app-id>
WECHAT_APP_SECRET=<server-only-secret>
PHONE_ENCRYPTION_KEY=<independent-strong-secret>
JWT_SECRET=<independent-strong-secret>
PUBLIC_BASE_URL=https://api.example.com
```

还需要在微信公众平台完成：

- 手机号快速验证能力、额度和计费确认。
- 用户协议与隐私保护指引配置。
- HTTPS request、uploadFile 和 downloadFile 合法域名配置。
- iOS 与 Android 真机登录、全屏播放及相册保存验收。

AppSecret、微信 access token、session_key、OpenID、完整手机号和手机号密文只能留在服务端，不能写入小程序代码、缓存或日志。

更完整的验收清单见 [微信登录与结果功能验证说明](docs/wechat-login-result-verification.md)。

## 输出结果

CLI 默认将结果写入：

```text
outputs/<视频文件名>/
```

常见文件包括：

| 文件 | 内容 |
| --- | --- |
| `metadata.json` | 输入视频、模型、球场标注和输出文件元数据 |
| `detections.jsonl` | 逐帧球员、姿态、速度、回合和羽毛球坐标 |
| `detect_<视频文件名>.mp4` | 带骨架、轨迹和统计信息的结果视频 |
| `court_annotations.txt` | 当前视角的球场四角标注缓存 |
| `position_visualizations/heatmaps/` | 球员位置热力图 |
| `position_visualizations/scatter_plots/` | 球员位置散点图 |

更换视频视角、裁切方式或模板图后，不应继续复用旧的 `court_annotations.txt`。请重新校准球场。

## 模型与性能

性能取决于视频分辨率、模型大小、GPU、是否保留音频以及是否生成位置图表。使用 `--performance-stats` 可以定期输出各处理阶段的耗时。

`pose-mode` 提供三个档位：

- `lightweight`：速度优先。
- `balanced`：速度与检测效果折中。
- `performance`：使用更大模型，速度较慢。

YOLO Pose 通过 `--yolo-pose-model` 单独指定模型文件，不使用 `pose-mode` 选择权重。

## 项目结构

```text
Good-Badminton/
├── main.py                    # CLI 入口
├── badminton_analysis/        # 视频分析核心
│   ├── court/                 # 球场检测与坐标映射
│   ├── data/                  # 元数据和 JSONL 输出
│   ├── detection/             # 姿态与羽毛球检测
│   ├── media/                 # 视频、音频处理
│   ├── tracking/              # 球员追踪与统计
│   └── visualization/         # 结果视频和位置图表
├── webui/                     # Gradio 页面与流程编排
├── backend/                   # FastAPI、SQLAlchemy、Alembic
├── infra/                     # Docker Compose 开发环境
├── wx_app/                    # 原生微信小程序
├── weights/                   # 默认模型权重
├── outputs/                   # 本地分析结果
└── requirements.txt           # 根目录 Python 依赖
```

## 测试

后端：

```bash
cd backend
python -m pytest -q
```

小程序逻辑测试和类型检查：

```bash
cd wx_app
npm install
npm test
npm run typecheck
```

小程序测试不代替微信开发者工具和真机验证。

## 当前限制

- 固定机位、完整球场和清晰场线更容易获得稳定结果。
- 羽毛球在视频中像素很少，压缩、运动模糊和遮挡会明显影响检测。
- 自动球场检测可能失败，项目保留了手动四角校准流程。
- 击球点和技术动作统计仍属于实验能力。
- 单机分析计算量较大，CPU 更适合短视频和功能验证。
- 微信手机号和相册能力受平台权限、额度、隐私申报及真机系统行为影响。

## 致谢

视频分析部分来自 [yo-WASSUP/Good-Badminton](https://github.com/yo-WASSUP/Good-Badminton) 及其贡献者。上游项目使用了 OpenMMLab、RTMPose、RTMO、[rtmlib](https://github.com/Tau-J/rtmlib) 和 [Ultralytics](https://github.com/ultralytics/ultralytics) 提供的模型与工具，也参考了 [TrackNet](https://github.com/yastrebksv/TrackNet) 的羽毛球数据集整理工作。

## 许可证

本仓库在 Apache License 2.0 下保留并修改上游代码，详见 [LICENSE](LICENSE)。重新分发时应保留上游版权和归属说明，并标明本仓库做过修改。模型权重仍遵循各自上游许可证，请在分发和商业使用前核对对应条款。
