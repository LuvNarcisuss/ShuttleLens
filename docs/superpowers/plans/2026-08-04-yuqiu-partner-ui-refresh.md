# “羽球拍档”微信小程序界面换肤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有业务逻辑的前提下，将六个微信原生小程序页面统一为已确认的“羽球拍档”明亮蓝白、活力亲和视觉。

**Architecture:** 继续使用微信原生 WXML、WXSS、JavaScript 和原生 tabBar。公共设计 token 与基础组件样式集中在 `app.wxss`，页面结构和特有布局保留在各页面目录；现有 `services/`、页面 JS、数据字段、路由和微信开放能力不改。

**Tech Stack:** 微信原生小程序、WXML、WXSS、CommonJS JavaScript、Node.js `node:test`、TypeScript `checkJs`。

## Global Constraints

- 品牌名称固定为“羽球拍档”。
- 主色固定为 `#1688FF`，深一级交互色为 `#0878E7`，成功色为 `#12B76A`，危险色为 `#E5484D`。
- 页面背景为 `#F5F7FA`，主文字为 `#1D2633`，次文字为 `#8C96A5`，分隔线为 `#E3E8EF`。
- 只改 `wx_app/miniprogram/`、相应小程序测试及必要的本地图片资源；不改后端、数据库、分析算法和服务接口。
- 不迁移 uni-app，不引入 Vue、React、TDesign 或其他组件库。
- 不删除或重构未注册的 `pages/home`。
- 自动化验证必须运行 `npm test` 和 `npm run typecheck`；微信开发者工具与真机未执行时必须明确说明。
- 测试或验证产生的临时目录、缓存和临时资产生成脚本必须在结束前清理。

## File Structure

- Create: `wx_app/miniprogram/app.wxss` — 全局 token、页面背景、通用按钮与状态样式。
- Modify: `wx_app/miniprogram/app.json` — 品牌导航配置、tabBar 颜色和四个图标路径。
- Create: `wx_app/miniprogram/assets/tabbar/tasks.png`
- Create: `wx_app/miniprogram/assets/tabbar/tasks-active.png`
- Create: `wx_app/miniprogram/assets/tabbar/profile.png`
- Create: `wx_app/miniprogram/assets/tabbar/profile-active.png`
- Create: `wx_app/miniprogram/assets/brand/shuttle.png` — 登录页使用的蓝白羽毛球标识。
- Modify: 六个已注册页面的 WXML/WXSS；JS 仅在测试证明视觉所需字段无法由现有数据表达时才允许小范围调整。
- Create: `wx_app/tests/pages/ui-refresh.test.js` — 品牌、导航、资源和六页视觉结构契约。
- Preserve: `wx_app/miniprogram/services/**`、后端代码和 `pages/home/**`。

---

### Task 1: 公共主题、品牌导航与 tabBar 资源

**Files:**
- Create: `wx_app/miniprogram/app.wxss`
- Modify: `wx_app/miniprogram/app.json`
- Create: `wx_app/miniprogram/assets/tabbar/tasks.png`
- Create: `wx_app/miniprogram/assets/tabbar/tasks-active.png`
- Create: `wx_app/miniprogram/assets/tabbar/profile.png`
- Create: `wx_app/miniprogram/assets/tabbar/profile-active.png`
- Create: `wx_app/miniprogram/assets/brand/shuttle.png`
- Create: `wx_app/tests/pages/ui-refresh.test.js`
- Modify: `wx_app/tests/pages/tabbar.test.js`

**Interfaces:**
- Consumes: 微信原生 `window`、`tabBar` 配置格式。
- Produces: 全局类 `.brand-page`、`.brand-card`、`.brand-primary-button`、`.brand-secondary-button`、`.brand-status-tag`，以及 tabBar 的普通态和选中态 PNG。

- [ ] **Step 1: 写入失败的品牌与导航契约测试**

在 `ui-refresh.test.js` 中加入：

```js
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "../../miniprogram");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("app exposes the 羽球拍档 blue-white theme and local tab icons", () => {
  const app = JSON.parse(read("app.json"));
  const theme = read("app.wxss");
  assert.equal(app.window.navigationBarTitleText, "羽球拍档");
  assert.equal(app.window.navigationBarBackgroundColor, "#FFFFFF");
  assert.equal(app.tabBar.color, "#8C96A5");
  assert.equal(app.tabBar.selectedColor, "#0878E7");
  assert.match(theme, /--brand-primary:\s*#1688FF/);
  for (const item of app.tabBar.list) {
    assert.ok(existsSync(resolve(root, item.iconPath)));
    assert.ok(existsSync(resolve(root, item.selectedIconPath)));
  }
  assert.ok(existsSync(resolve(root, "assets/brand/shuttle.png")));
});
```

将 `tabbar.test.js` 的期望对象更新为含 `iconPath`、`selectedIconPath` 的两项配置，并保持页面顺序不变。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `cd wx_app && npm test -- --test-name-pattern="羽球拍档|task center"`

Expected: FAIL，原因是 `app.wxss` 或 tabBar 图片不存在，且标题仍为“羽毛球姿态检测”。

- [ ] **Step 3: 实现公共样式和配置**

`app.wxss` 至少包含以下稳定接口：

```css
page {
  --brand-primary: #1688FF;
  --brand-primary-strong: #0878E7;
  --brand-success: #12B76A;
  --brand-danger: #E5484D;
  --brand-bg: #F5F7FA;
  --brand-text: #1D2633;
  --brand-muted: #8C96A5;
  --brand-divider: #E3E8EF;
  background: var(--brand-bg);
  color: var(--brand-text);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
}

.brand-card { border-radius: 20rpx; background: #FFFFFF; box-shadow: 0 6rpx 20rpx rgba(35, 72, 120, .10); }
.brand-primary-button { background: var(--brand-primary); color: #FFFFFF; }
.brand-secondary-button { background: #EAF4FF; color: var(--brand-primary-strong); }
.brand-status-tag { background: var(--brand-primary); color: #FFFFFF; }
```

在 `app.json` 中配置白色原生导航、黑色标题、浅灰 tabBar 分隔线、蓝灰两态颜色，并将文字改为“任务”“我的”。

- [ ] **Step 4: 生成并检查四个 tabBar PNG**

生成 81×81、透明背景、线宽一致的本地图标：任务页使用房屋轮廓，个人页使用头像轮廓；普通态颜色 `#8C96A5`，选中态颜色 `#0878E7`。图片存入 `miniprogram/assets/tabbar/`。同时生成 160×160、透明背景、蓝色羽毛球主体和白色内部线条的 `miniprogram/assets/brand/shuttle.png`。逐个确认 PNG 签名、尺寸和透明背景；若使用临时生成脚本，生成后立即删除脚本。

- [ ] **Step 5: 运行导航契约测试并确认绿灯**

Run: `cd wx_app && npm test -- --test-name-pattern="羽球拍档|task center"`

Expected: PASS。

- [ ] **Step 6: 提交公共主题**

```powershell
git add wx_app/miniprogram/app.json wx_app/miniprogram/app.wxss wx_app/miniprogram/assets/tabbar wx_app/miniprogram/assets/brand wx_app/tests/pages/tabbar.test.js wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: add yuqiupaidang visual foundation"
```

### Task 2: 任务首页换肤

**Files:**
- Modify: `wx_app/miniprogram/pages/tasks/index.wxml`
- Modify: `wx_app/miniprogram/pages/tasks/index.wxss`
- Modify: `wx_app/tests/pages/ui-refresh.test.js`
- Test: `wx_app/tests/pages/tasks-runtime.test.js`

**Interfaces:**
- Consumes: 现有 `tasks`、`filters`、`statusFilter`、`isLoading`、`nextCursor` 和页面事件。
- Produces: `.task-hero`、`.task-card`、`.task-tag`、`.task-progress` 视觉结构，不新增页面状态。

- [ ] **Step 1: 添加失败的任务页结构测试**

```js
test("tasks page uses the approved hero and card hierarchy", () => {
  const wxml = read("pages/tasks/index.wxml");
  const wxss = read("pages/tasks/index.wxss");
  assert.match(wxml, /class="task-hero"/);
  assert.match(wxml, />开始一场复盘</);
  assert.match(wxml, /class="task-card/);
  assert.match(wxss, /\.task-hero/);
  assert.match(wxss, /#1688FF/);
});
```

- [ ] **Step 2: 运行任务页测试并确认红灯**

Run: `cd wx_app && npm test -- --test-name-pattern="approved hero|tasks page"`

Expected: 新结构测试 FAIL；既有运行时测试 PASS。

- [ ] **Step 3: 重排 WXML 并实现页面样式**

将现有 `masthead` 改为 `task-hero`，品牌标题使用“开始一场复盘”，保留“新分析”按钮事件。任务循环继续使用原来的 `data-task-id`、`bindtap`、`catchtap` 和条件按钮，仅改为白色横向卡片、蓝绿状态标签与蓝色进度。保留筛选、分页、失败提示和空状态。

- [ ] **Step 4: 运行任务页契约与运行时测试**

Run: `cd wx_app && npm test -- --test-name-pattern="approved hero|tasks page"`

Expected: PASS。

- [ ] **Step 5: 提交任务首页**

```powershell
git add wx_app/miniprogram/pages/tasks wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: refresh task center interface"
```

### Task 3: 智能分析四步流程换肤

**Files:**
- Modify: `wx_app/miniprogram/pages/analyze/index.wxml`
- Modify: `wx_app/miniprogram/pages/analyze/index.wxss`
- Modify: `wx_app/tests/pages/ui-refresh.test.js`
- Test: `wx_app/tests/pages/analyze-runtime.test.js`

**Interfaces:**
- Consumes: 现有视频、预设、校准、进度字段及全部事件处理器。
- Produces: `.analysis-hero`、`.analysis-step-card`、`.step-index`、`.calibration-panel`。

- [ ] **Step 1: 添加失败的四步视觉契约测试**

```js
test("analysis page keeps four numbered blue-white steps", () => {
  const wxml = read("pages/analyze/index.wxml");
  assert.match(wxml, /class="analysis-hero"/);
  assert.equal((wxml.match(/class="step-index"/g) || []).length, 4);
  for (const title of ["选择比赛视频", "选择分析档位", "检测并校准球场", "开始分析"]) {
    assert.match(wxml, new RegExp(title));
  }
});
```

- [ ] **Step 2: 运行分析页测试并确认红灯**

Run: `cd wx_app && npm test -- --test-name-pattern="four numbered|analyze page|court detection|manual corner|video selection|analysis saves"`

Expected: 新视觉测试 FAIL，既有业务测试 PASS。

- [ ] **Step 3: 实现四步卡片、按钮和校准状态样式**

为四段卡片增加 `analysis-step-card` 与 `step-index`，编号固定为 `01`–`04`。将主按钮、次按钮、禁用态、自动检测失败提示、四角标记、缩放控件和进度统一为蓝白体系；不得修改 `chooseVideo`、`detectCourt`、`addCorner`、`moveCorner`、`saveManualCorners`、`startAnalysis` 绑定。

- [ ] **Step 4: 运行分析页契约与完整运行时测试**

Run: `cd wx_app && node --import tsx --test tests/pages/analyze-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: PASS。

- [ ] **Step 5: 提交智能分析页**

```powershell
git add wx_app/miniprogram/pages/analyze wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: refresh analysis workflow interface"
```

### Task 4: 分析结果页换肤

**Files:**
- Modify: `wx_app/miniprogram/pages/result/index.wxml`
- Modify: `wx_app/miniprogram/pages/result/index.wxss`
- Modify: `wx_app/tests/pages/ui-refresh.test.js`
- Test: `wx_app/tests/pages/result-runtime.test.js`

**Interfaces:**
- Consumes: `pageState`、视频、指标、高光、分享、图表、下载与权限字段。
- Produces: `.result-hero`、`.result-card`、`.metric-card`、`.result-state-card`、`.result-sheet`。

- [ ] **Step 1: 添加失败的结果页结构测试**

```js
test("result page uses the approved blue data hierarchy", () => {
  const wxml = read("pages/result/index.wxml");
  assert.match(wxml, /class="result-hero"/);
  assert.match(wxml, /class="card result-card/);
  assert.match(wxml, /class="metric-card"/);
  assert.match(wxml, /权限|前往设置/);
});
```

- [ ] **Step 2: 运行结果页测试并确认红灯**

Run: `cd wx_app && node --import tsx --test tests/pages/result-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: 新结构测试 FAIL，既有视频、下载、权限、高光测试 PASS。

- [ ] **Step 3: 实现结果页视觉层级**

保留全部条件分支和事件绑定，将顶部改为 `result-hero`，内容卡片增加 `result-card`。数据范围选项、球员切换、指标卡、高光操作、分享卡、编辑底部弹层、下载进度和权限恢复均使用统一蓝绿红语义；视频保持 `object-fit="contain"` 和横屏全屏能力。

- [ ] **Step 4: 运行结果页契约与完整运行时测试**

Run: `cd wx_app && node --import tsx --test tests/pages/result-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: PASS。

- [ ] **Step 5: 提交结果页**

```powershell
git add wx_app/miniprogram/pages/result wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: refresh analysis result interface"
```

### Task 5: 登录流程换肤

**Files:**
- Modify: `wx_app/miniprogram/pages/login/index.wxml`
- Modify: `wx_app/miniprogram/pages/login/index.wxss`
- Modify: `wx_app/tests/pages/ui-refresh.test.js`
- Test: `wx_app/tests/pages/login-runtime.test.js`

**Interfaces:**
- Consumes: `step`、`agreed`、`isLoading`、`errorMessage` 及现有授权事件。
- Produces: `.login-brand`、`.brand-shuttle`、`.login-panel`、`.agreement-row`。

- [ ] **Step 1: 添加失败的登录品牌测试**

```js
test("login page presents the 羽球拍档 friendly brand", () => {
  const wxml = read("pages/login/index.wxml");
  assert.match(wxml, /欢迎使用羽球拍档/);
  assert.match(wxml, /记录比赛，看见每一次进步/);
  assert.match(wxml, /class="login-panel"/);
  assert.match(wxml, /src="\/assets\/brand\/shuttle\.png"/);
  assert.match(wxml, /open-type="getPhoneNumber"/);
});
```

- [ ] **Step 2: 运行登录测试并确认红灯**

Run: `cd wx_app && node --import tsx --test tests/pages/login-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: 品牌结构测试 FAIL，既有协议、手机号和跳转测试 PASS。

- [ ] **Step 3: 实现登录页品牌和各步骤状态**

将页面标题改为“欢迎使用羽球拍档”，使用 `<image class="brand-shuttle" src="/assets/brand/shuttle.png" mode="aspectFit" />` 呈现本地蓝白羽毛球标识；协议、微信快捷登录、手机号绑定、资料完善、完成和错误状态保持原条件分支。按钮加载态和禁用态必须保留。

- [ ] **Step 4: 运行登录页测试并确认绿灯**

Run: `cd wx_app && node --import tsx --test tests/pages/login-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: PASS。

- [ ] **Step 5: 提交登录页**

```powershell
git add wx_app/miniprogram/pages/login wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: refresh login interface"
```

### Task 6: 个人中心与资料编辑换肤

**Files:**
- Modify: `wx_app/miniprogram/pages/profile/index.wxml`
- Modify: `wx_app/miniprogram/pages/profile/index.wxss`
- Modify: `wx_app/miniprogram/pages/profile-edit/index.wxml`
- Modify: `wx_app/miniprogram/pages/profile-edit/index.wxss`
- Modify: `wx_app/tests/pages/ui-refresh.test.js`
- Test: `wx_app/tests/pages/profile-runtime.test.js`
- Test: `wx_app/tests/pages/profile-edit-runtime.test.js`

**Interfaces:**
- Consumes: 现有资料、任务、登录、头像、昵称、手机号和错误字段。
- Produces: `.profile-hero`、`.profile-section`、`.profile-danger-action`、`.profile-form-row`。

- [ ] **Step 1: 添加失败的两页结构测试**

```js
test("profile pages use blue identity and divided form sections", () => {
  const profile = read("pages/profile/index.wxml");
  const edit = read("pages/profile-edit/index.wxml");
  assert.match(profile, /class="profile-hero"/);
  assert.match(profile, /class="profile-danger-action"/);
  assert.match(edit, /class="profile-form-row"/);
  assert.match(edit, /open-type="chooseAvatar"/);
  assert.match(edit, /open-type="getPhoneNumber"/);
});
```

- [ ] **Step 2: 运行个人资料测试并确认红灯**

Run: `cd wx_app && node --import tsx --test tests/pages/profile-runtime.test.js tests/pages/profile-edit-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: 新结构测试 FAIL，既有登录、任务跳转、头像昵称和手机号测试 PASS。

- [ ] **Step 3: 实现个人中心布局**

将头像、昵称、登录状态和脱敏手机号放入蓝色 `profile-hero`。最近任务、资料入口和账号操作分区展示；未登录按钮保持 `login` 事件，资料按钮保持 `editProfile`，退出按钮使用独立危险样式并保持 `logout`。

- [ ] **Step 4: 实现资料编辑布局**

将头像、昵称、手机号重排为纵向分区，输入与错误状态靠近对应字段。保留 `chooseAvatar`、`onNicknameInput`、`onNicknameBlur`、`getPhoneNumber`、`replacePhone` 和 `submit` 绑定，不改变上传与保存顺序。

- [ ] **Step 5: 运行两页契约与运行时测试**

Run: `cd wx_app && node --import tsx --test tests/pages/profile-runtime.test.js tests/pages/profile-edit-runtime.test.js tests/pages/ui-refresh.test.js`

Expected: PASS。

- [ ] **Step 6: 提交个人资料页面**

```powershell
git add wx_app/miniprogram/pages/profile wx_app/miniprogram/pages/profile-edit wx_app/tests/pages/ui-refresh.test.js
git commit -m "feat: refresh profile interfaces"
```

### Task 7: 全量验证、视觉检查与清理

**Files:**
- Verify: `wx_app/miniprogram/app.json`
- Verify: `wx_app/miniprogram/app.wxss`
- Verify: `wx_app/miniprogram/pages/**`
- Verify: `wx_app/tests/**`

**Interfaces:**
- Consumes: Tasks 1–6 的完整实现。
- Produces: 自动化验证结果、人工检查记录和无临时残留的工作区。

- [ ] **Step 1: 运行完整小程序测试**

Run: `cd wx_app && npm test`

Expected: 全部测试 PASS，0 failed。

- [ ] **Step 2: 运行类型检查**

Run: `cd wx_app && npm run typecheck`

Expected: 退出码 0，无 TypeScript 错误。

- [ ] **Step 3: 静态核对配置和资源**

检查 `app.json` 的六个页面均存在，四个 tabBar 图片路径均可解析，所有 JSON 可被 `JSON.parse`，新增 WXML 事件名在对应 JS 中存在。

- [ ] **Step 4: 在微信开发者工具执行视觉验收**

检查任务、分析、结果、登录、个人中心、资料编辑六页；至少覆盖正常、加载、空、错误、禁用状态以及窄屏和常见全面屏。确认底部安全区、长文件名截断、弹层滚动、视频横屏和四角校准操作不受影响。

- [ ] **Step 5: 清理验证残留并检查最终差异**

删除本轮产生的测试缓存、临时资产生成脚本和临时目录；运行 `git status --short`，确认没有 `.pytest_cache`、`.pytest-*`、测试 basetemp 或其他临时文件。只保留计划内代码、资源和测试变更。

- [ ] **Step 6: 提交最终验证修正**

若视觉或验证阶段产生必要修正，限定路径暂存并提交：

```powershell
git add wx_app/miniprogram wx_app/tests
git commit -m "test: verify yuqiupaidang ui refresh"
```

若没有新增修正，不创建空提交。
