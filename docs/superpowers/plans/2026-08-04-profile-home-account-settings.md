# Profile Home And Account Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“我的”页重构为含双入口、最近分析和上半场球员生涯快照的主页，并新增只开放真实账户能力的账号设置页。

**Architecture:** 保留微信原生页面结构，在 `pages/profile` 中复用现有资料、任务和结果服务，选择最近成功任务并读取 `analytics.players.upper`。账号设置作为独立原生页面，只复用现有资料、手机号绑定和本地退出能力；未有后端支持的操作保持明确禁用。

**Tech Stack:** 微信原生 WXML/WXSS/CommonJS JavaScript、微信 `Page`/`wx.*` API、Node.js `node:test`、TypeScript `checkJs`。

## Global Constraints

- 品牌名称保持“羽球拍档”，风格保持明亮蓝白、活力亲和。
- 继续使用微信原生 WXML、WXSS 和 JavaScript，不引入 uni-app、第三方组件库或新依赖。
- 第一版固定读取最近一次成功分析中的 `analytics.players.upper`，页面必须标注“最近一次分析 · 上半场球员”。
- 不建立跨场次累计，不新增密码、微信解绑、身份切换或账号注销后端能力。
- 暂未开放项必须禁用且不绑定伪操作；账号注销不能用清理本地缓存冒充。
- 所有关键触控区域至少 `88rpx × 88rpx`，底部保留 `env(safe-area-inset-bottom)`。
- 不为纯 WXML/WXSS 外观新增脆弱源码匹配或快照测试；使用运行时测试、配置解析和微信开发者工具视觉验收。
- 不修改分析算法、任务接口、登录协议、后端数据模型或 `services/**` 协议。
- 保护仓库中既有未跟踪文件；每次只暂存任务明确列出的路径，不使用 `git add .`。
- 测试结束后清理本次生成的缓存和临时目录，不删除来源不明的既有缓存。

## File Structure

- Modify: `wx_app/miniprogram/pages/profile/index.js` — 主页数据协调、上半场指标格式化和页面跳转。
- Modify: `wx_app/miniprogram/pages/profile/index.wxml` — 个人信息区、我的分析、最近分析和羽球生涯结构。
- Modify: `wx_app/miniprogram/pages/profile/index.wxss` — 主页蓝色头部、图标按钮、任务卡和 3×3 指标布局。
- Create: `wx_app/miniprogram/pages/account-settings/index.js` — 账号资料加载、手机号更换和退出确认。
- Create: `wx_app/miniprogram/pages/account-settings/index.json` — 页面导航标题。
- Create: `wx_app/miniprogram/pages/account-settings/index.wxml` — 账号状态列表和操作区。
- Create: `wx_app/miniprogram/pages/account-settings/index.wxss` — 设置页列表、可用/禁用/危险状态。
- Modify: `wx_app/miniprogram/app.json` — 注册账号设置页。
- Modify: `wx_app/tests/pages/profile-runtime.test.js` — 主页数据和导航运行时测试。
- Create: `wx_app/tests/pages/account-settings-runtime.test.js` — 设置页运行时测试。
- Modify: `wx_app/tests/pages/tabbar.test.js` — 更新已注册页面清单。

---

### Task 1: Profile Career Snapshot And Navigation Logic

**Files:**
- Modify: `wx_app/miniprogram/pages/profile/index.js`
- Modify: `wx_app/tests/pages/profile-runtime.test.js`

**Interfaces:**
- Consumes: `listTasks()` from `../../services/analysis`, `getAnalytics(taskId)` from `../../services/result`, `getCurrentProfile()` from `../../services/profile`, `getAccessToken()` from `../../services/token`.
- Produces: `formatCareerMetrics(player): CareerMetric[]`, `tasks` limited to two recent safe tasks, `latestSucceededTaskId`, `careerState`, `careerMetrics`, `accountDisplay`, and navigation handlers `openAnalysisTasks()`, `openAccountSettings()`, `openCareerResult()`.
- `CareerMetric` shape: `{ key: string, label: string, value: string, unit: string }`.

- [ ] **Step 1: Extend the test loader with the result service**

Update the `loadPage` signature and `require` branch in `profile-runtime.test.js`:

```js
function loadPage({ profile = {}, analysis = {}, result = {}, token = "", wx = {} } = {}) {
  let definition;
  vm.runInNewContext(readFileSync(resolve(pageDirectory, "index.js"), "utf8"), {
    require(request) {
      if (request === "../../services/profile") return profile;
      if (request === "../../services/analysis") return analysis;
      if (request === "../../services/result") return result;
      if (request === "../../services/token") return { getAccessToken: () => token };
      throw new Error(`Unexpected dependency: ${request}`);
    },
    Page(value) { definition = value; },
    wx,
    console,
    Promise,
  }, { filename: resolve(pageDirectory, "index.js") });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
}
```

Keep the existing `auth` injection during Task 1 because the current WXML still exposes the logout button. Task 2 removes the old account-security markup and the matching JS dependency together, so every intermediate commit remains runnable.

- [ ] **Step 2: Write failing tests for the latest upper-player snapshot**

Add a test using a task list with a running item followed by a successful item. The result stub must record the selected task ID and return this payload:

```js
{
  quality: { confidence: "high" },
  players: {
    upper: {
      average_speed_mps: { value: 2.5, unit: "m/s", available: true },
      maximum_speed_mps: { value: 4, unit: "m/s", available: true },
      distance_m: { value: 42.5, unit: "m", available: true },
      court_coverage_ratio: { value: 0.25, unit: "ratio", available: true },
      zones: { front: 0.2, mid: 0.5, back: 0.3 },
      sides: { left: 0.45, right: 0.55 },
    },
  },
}
```

Assert:

```js
assert.deepEqual(calls, ["task-success"]);
assert.equal(page.data.latestSucceededTaskId, "task-success");
assert.equal(page.data.careerState, "ready");
assert.equal(page.data.tasks.length, 2);
assert.deepEqual(
  JSON.parse(JSON.stringify(page.data.careerMetrics.map(({ value, unit }) => [value, unit]))),
  [
    ["9.0", "km/h"], ["14.4", "km/h"], ["42.5", "m"],
    ["25", "%"], ["20", "%"], ["50", "%"],
    ["30", "%"], ["45", "%"], ["55", "%"],
  ],
);
```

- [ ] **Step 3: Write failing tests for missing analytics and navigation**

Cover these independent behaviors:

```js
assert.equal(page.data.careerState, "empty"); // no succeeded task
assert.equal(page.data.careerMetrics.every((item) => item.value === "—"), true);
```

When `getAnalytics` rejects, assert `careerState === "unavailable"` while profile data and the two recent tasks remain present.

For navigation, stub `navigateTo` and `switchTab`, then assert:

```js
page.editProfile();
page.openAccountSettings();
page.openAnalysisTasks();
page.setData({ latestSucceededTaskId: "task-success" });
page.openCareerResult();

assert.deepEqual(calls, [
  ["navigateTo", "/pages/profile-edit/index"],
  ["navigateTo", "/pages/account-settings/index"],
  ["switchTab", "/pages/tasks/index"],
  ["navigateTo", "/pages/result/index?task_id=task-success"],
]);
```

- [ ] **Step 4: Run the focused test and verify red**

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/profile-runtime.test.js
```

Expected: FAIL because the profile page does not require `../../services/result`, does not expose career state/metrics, still keeps more than two tasks, and lacks the new navigation handlers.

- [ ] **Step 5: Implement metric formatting and isolated analytics loading**

In `profile/index.js`, keep the profile-page logout dependency for this task and add:

```js
const { getAnalytics } = require("../../services/result");

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
```

Add initial data:

```js
accountDisplay: "",
latestSucceededTaskId: "",
careerState: "loading",
careerMetrics: formatCareerMetrics(),
careerErrorMessage: "",
```

In `loadPageData()`:

1. Keep profile and task requests in `Promise.allSettled`.
2. Set `accountDisplay` from `profile.id`, using the full value when at most 12 characters and otherwise `…${String(profile.id).slice(-8)}`.
3. Map only `items.slice(0, 2)` into `tasks`.
4. Find the first successful item from the full `items` array.
5. If absent, set `careerState: "empty"`.
6. If present, call `getAnalytics(id)` and set `careerState: "ready"`, `latestSucceededTaskId` and `formatCareerMetrics((analytics.players || {}).upper || {})`.
7. If analytics fails, preserve profile/tasks and set `careerState: "unavailable"` with `careerErrorMessage: "本次结果暂无生涯数据"`.

Add the navigation handlers exactly as asserted in Step 3. Keep the existing login, logout and `openTask` behavior.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/profile-runtime.test.js
npm run typecheck
```

Expected: all profile runtime tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- wx_app/miniprogram/pages/profile/index.js wx_app/tests/pages/profile-runtime.test.js
git diff --cached --check
git commit -m "feat: add upper-player career snapshot"
```

---

### Task 2: Profile Home Layout

**Files:**
- Modify: `wx_app/miniprogram/pages/profile/index.js`
- Modify: `wx_app/miniprogram/pages/profile/index.wxml`
- Modify: `wx_app/miniprogram/pages/profile/index.wxss`
- Modify: `wx_app/tests/pages/profile-runtime.test.js`

**Interfaces:**
- Consumes: Task 1 data fields `accountDisplay`, `tasks`, `latestSucceededTaskId`, `careerState`, `careerMetrics`, `careerErrorMessage` and its four navigation handlers.
- Produces: the complete “我的” visual hierarchy without the old profile settings and account security cards.

- [ ] **Step 1: Run the profile runtime baseline**

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/profile-runtime.test.js
```

Expected: PASS before the intentional removal of the old profile cards. This task does not add new WXML/WXSS source-text matching tests.

- [ ] **Step 2: Align the existing runtime test with the approved removal**

Update `profile-runtime.test.js` only to remove the obsolete `auth.logout` injection, the direct `logout()` test, and source assertions that require the removed profile-data and logout cards. Preserve every unrelated runtime assertion. This is maintenance of existing behavior tests, not a new visual source-text test.

- [ ] **Step 3: Replace the hero with the approved profile header**

Structure `profile/index.wxml` as:

```xml
<scroll-view class="page" scroll-y>
  <view class="profile-hero">
    <view class="hero-actions" wx:if="{{isLoggedIn}}">
      <button class="hero-icon-button" aria-label="个人信息" bindtap="editProfile">✎</button>
      <button class="hero-icon-button" aria-label="账号设置" bindtap="openAccountSettings">⚙</button>
    </view>
    <view class="hero-person">
      <view class="avatar-shell">
        <image wx:if="{{avatarUrl}}" class="avatar" src="{{avatarUrl}}" mode="aspectFill" />
        <text wx:else class="avatar-fallback">羽</text>
      </view>
      <view class="identity">
        <text class="name">{{displayName}}</text>
        <text class="status {{isLoggedIn ? 'online' : ''}}">{{loginStatus}}</text>
        <text wx:if="{{isLoggedIn && accountDisplay}}" class="account-id">账号 · {{accountDisplay}}</text>
        <text wx:if="{{isLoggedIn && maskedPhone}}" class="phone">{{maskedPhone}}</text>
      </view>
    </view>
    <button wx:if="{{!isLoggedIn && !isLoading}}" class="login" bindtap="login">微信快捷登录</button>
    <button class="analysis-shortcut" bindtap="openAnalysisTasks" aria-label="进入我的分析">
      <text class="analysis-shortcut-icon">◉</text>
      <text>我的分析</text>
    </button>
  </view>
```

Use native buttons with `aria-label`; do not add image dependencies for the two compact icons.

- [ ] **Step 4: Build the recent analysis section**

Keep current loading, empty, error, progress and result-entry behavior, but change the heading to:

```xml
<view class="section-heading">
  <text>最近分析</text>
  <button class="section-link" bindtap="openAnalysisTasks">查看更多</button>
</view>
```

Render only the already-truncated `tasks` array. Preserve `data-task-id` and `bindtap="openTask"`.

- [ ] **Step 5: Add the 3×3 career section**

Append this section after recent analysis:

```xml
<view class="career-section">
  <view class="career-heading">
    <view>
      <text class="career-title">羽球生涯</text>
      <text class="career-caption">最近一次分析 · 上半场球员</text>
    </view>
    <button wx:if="{{latestSucceededTaskId}}" class="section-link" bindtap="openCareerResult">查看本场详情</button>
  </view>
  <view wx:if="{{careerState === 'loading'}}" class="career-state">生涯数据加载中…</view>
  <view wx:elif="{{careerState === 'empty'}}" class="career-state">
    <text>完成一次分析后，这里会生成你的羽球数据</text>
    <button class="career-empty-action" bindtap="openAnalysisTasks">开始分析</button>
  </view>
  <view wx:elif="{{careerState === 'unavailable'}}" class="career-state">{{careerErrorMessage}}</view>
  <view wx:else class="career-grid">
    <view class="career-metric" wx:for="{{careerMetrics}}" wx:key="key">
      <text class="career-label">{{item.label}}</text>
      <view class="career-value-row">
        <text class="career-value">{{item.value}}</text>
        <text wx:if="{{item.value !== '—'}}" class="career-unit">{{item.unit}}</text>
      </view>
    </view>
  </view>
</view>
```

Delete the old `profile-account-section` and `profile-security-section` markup entirely. In the same step, remove the now-unreachable `clearLocalSession` import and `logout()` method from `profile/index.js`.

- [ ] **Step 6: Implement responsive WXSS**

Use the existing brand variables and these layout contracts:

```css
.page { height: 100vh; box-sizing: border-box; padding: 0 24rpx calc(32rpx + env(safe-area-inset-bottom)); }
.profile-hero { position: relative; margin: 0 -24rpx; padding: 38rpx 30rpx 34rpx; border-radius: 0 0 34rpx 34rpx; }
.hero-actions { position: absolute; top: 20rpx; right: 22rpx; display: flex; gap: 8rpx; }
.hero-icon-button { display: flex; align-items: center; justify-content: center; width: 88rpx; min-width: 88rpx; height: 88rpx; margin: 0; padding: 0; background: transparent; color: #FFFFFF; }
.hero-person { display: flex; align-items: center; gap: 22rpx; padding-right: 184rpx; }
.analysis-shortcut { display: flex; align-items: center; flex-direction: column; justify-content: center; width: 190rpx; min-height: 116rpx; margin: 28rpx 0 0 112rpx; background: transparent; color: #FFFFFF; }
.career-section { margin-top: 22rpx; padding: 30rpx 18rpx; border-radius: 22rpx; background: #FFFFFF; }
.career-grid { display: grid; grid-template-columns: repeat(3, 1fr); }
.career-metric { min-width: 0; padding: 22rpx 8rpx; text-align: center; }
.career-value { font-size: 34rpx; font-weight: 700; }
.section-link, .career-empty-action { min-height: 88rpx; }
```

Ensure the grid works at narrow widths: labels may wrap to two lines, values must not overflow, and units use smaller text. Remove obsolete `.profile-account-section`, `.profile-security-section`, `.profile-edit-action` and `.profile-danger-action` styles.

- [ ] **Step 7: Run profile tests and static event check**

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/profile-runtime.test.js
npm run typecheck
```

Then verify every new `bindtap` name exists in `profile/index.js`.

Expected: tests and typecheck PASS; no missing handlers.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- wx_app/miniprogram/pages/profile/index.js wx_app/miniprogram/pages/profile/index.wxml wx_app/miniprogram/pages/profile/index.wxss wx_app/tests/pages/profile-runtime.test.js
git diff --cached --check
git commit -m "feat: refresh profile home layout"
```

---

### Task 3: Native Account Settings Page

**Files:**
- Create: `wx_app/miniprogram/pages/account-settings/index.js`
- Create: `wx_app/miniprogram/pages/account-settings/index.json`
- Create: `wx_app/miniprogram/pages/account-settings/index.wxml`
- Create: `wx_app/miniprogram/pages/account-settings/index.wxss`
- Create: `wx_app/tests/pages/account-settings-runtime.test.js`
- Modify: `wx_app/miniprogram/app.json`
- Modify: `wx_app/tests/pages/tabbar.test.js`

**Interfaces:**
- Consumes: `getCurrentProfile()` from `../../services/profile`, `bindPhone(code)` and `logout()` from `../../services/auth`.
- Produces: registered route `/pages/account-settings/index` with handlers `onShow()`, `replacePhone(event)` and `confirmLogout()`.

- [ ] **Step 1: Write the failing runtime test harness**

Create `account-settings-runtime.test.js` with a VM loader matching the existing profile-edit test. Inject only:

```js
if (path === "../../services/profile") return profile;
if (path === "../../services/auth") return auth;
```

Return the registered page definition with cloned `data` and a local `setData`.

- [ ] **Step 2: Write failing tests for profile load and phone binding**

Test `onShow()` with:

```js
profile: {
  async getCurrentProfile() {
    return { id: "1160805361", masked_phone: "138****8000" };
  },
},
```

Assert `accountId`, `maskedPhone`, `wechatStatus === "已绑定"` and `isLoading === false`.

Call `replacePhone({ detail: { code: "phone-code" } })`, assert `bindPhone` receives only `phone-code` and the returned masked number replaces the old value. Call again with `errMsg: "getPhoneNumber:fail user deny"` and assert the error text contains “拒绝”.

- [ ] **Step 3: Write failing tests for confirmed and cancelled logout**

Stub `wx.showModal` to capture its input. Invoke `confirmLogout()`, first call `success({ confirm: false })` and assert no logout. Invoke again with `success({ confirm: true })`, then assert:

```js
assert.deepEqual(calls, ["logout", ["switchTab", "/pages/profile/index"]]);
```

- [ ] **Step 4: Update the app config test and verify red**

Update the expected `config.pages` in `tabbar.test.js` by inserting:

```js
"pages/account-settings/index",
```

after `pages/profile-edit/index` and before `pages/result/index`.

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/account-settings-runtime.test.js tests/pages/tabbar.test.js
```

Expected: FAIL because the page files and route do not exist.

- [ ] **Step 5: Implement the account settings page logic**

Create `account-settings/index.js`:

```js
const { bindPhone, logout } = require("../../services/auth");
const { getCurrentProfile } = require("../../services/profile");

function phoneFailureMessage(errMsg) {
  const value = String(errMsg || "").toLowerCase();
  if (value.includes("quota")) return "手机号验证额度不足，请稍后再试";
  if (value.includes("deny")) return "你已拒绝手机号授权，可点击按钮重新尝试";
  if (value.includes("cancel")) return "已取消手机号授权";
  return "未获取到手机号授权凭证";
}

Page({
  data: {
    accountId: "—",
    maskedPhone: "",
    wechatStatus: "已绑定",
    isLoading: true,
    errorMessage: "",
  },

  onShow() { return this.loadAccount(); },

  async loadAccount() {
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await getCurrentProfile();
      this.setData({
        accountId: String(profile.id || "—"),
        maskedPhone: profile.masked_phone || "",
      });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "账号信息加载失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  async replacePhone(event) {
    const detail = (event && event.detail) || {};
    if (!detail.code) {
      this.setData({ errorMessage: phoneFailureMessage(detail.errMsg) });
      return;
    }
    this.setData({ isLoading: true, errorMessage: "" });
    try {
      const profile = await bindPhone(detail.code);
      this.setData({ maskedPhone: profile.masked_phone || "", errorMessage: "" });
    } catch (error) {
      this.setData({ errorMessage: (error && error.message) || "手机号更换失败" });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  confirmLogout() {
    if (this.data.isLoading) return;
    wx.showModal({
      title: "退出登录",
      content: "退出后需要重新进行微信登录，是否继续？",
      confirmText: "退出",
      confirmColor: "#E5484D",
      success: ({ confirm }) => {
        if (!confirm) return;
        logout();
        wx.switchTab({ url: "/pages/profile/index" });
      },
    });
  },
});
```

- [ ] **Step 6: Implement the page configuration and view**

Create `index.json`:

```json
{
  "navigationBarTitleText": "羽球拍档 · 账号设置"
}
```

Create `index.wxml` with no click handlers on unavailable controls:

```xml
<scroll-view class="page" scroll-y>
  <view class="settings-intro">
    <text class="settings-title">账号设置</text>
    <text class="settings-subtitle">管理登录方式与账户安全</text>
  </view>

  <view class="settings-card">
    <view class="settings-row">
      <text class="settings-label">账号 ID</text>
      <text class="settings-value account-value">{{accountId}}</text>
    </view>
    <view class="settings-row">
      <text class="settings-label">手机</text>
      <text class="settings-value">{{maskedPhone || '未绑定'}}</text>
      <button class="row-action" open-type="getPhoneNumber" bindgetphonenumber="replacePhone" loading="{{isLoading}}" disabled="{{isLoading}}">{{maskedPhone ? '更换' : '关联'}}</button>
    </view>
    <view class="settings-row">
      <text class="settings-label">微信</text>
      <text class="settings-value">{{wechatStatus}}</text>
      <button class="row-action unavailable" disabled>解绑 · 暂未开放</button>
    </view>
    <view class="settings-row settings-row-last">
      <text class="settings-label">密码</text>
      <text class="settings-value">微信账号暂无密码</text>
      <button class="row-action unavailable" disabled>重置 · 暂未开放</button>
    </view>
  </view>

  <view wx:if="{{isLoading || errorMessage}}" class="settings-feedback">
    <text wx:if="{{isLoading}}">账号信息加载中…</text>
    <text wx:if="{{errorMessage}}" class="settings-error">{{errorMessage}}</text>
  </view>

  <view class="settings-actions">
    <button class="settings-action identity-action" disabled>切换身份 · 暂未开放</button>
    <button class="settings-action logout-action" bindtap="confirmLogout" disabled="{{isLoading}}">退出登录</button>
    <button class="settings-action cancel-action" disabled>账号注销 · 暂未开放</button>
  </view>
</scroll-view>
```

- [ ] **Step 7: Implement account settings WXSS and register the page**

Use:

```css
.page { min-height: 100vh; box-sizing: border-box; padding: 24rpx 28rpx calc(44rpx + env(safe-area-inset-bottom)); background: var(--brand-bg); }
.settings-card { overflow: hidden; border: 1rpx solid var(--brand-divider); border-radius: 22rpx; background: #FFFFFF; }
.settings-row { display: flex; align-items: center; min-height: 112rpx; padding: 0 24rpx; border-bottom: 1rpx solid var(--brand-divider); }
.settings-label { width: 150rpx; color: var(--brand-text); }
.settings-value { flex: 1; min-width: 0; color: var(--brand-muted); word-break: break-all; }
.row-action, .settings-action { min-height: 88rpx; }
.settings-action[disabled] { opacity: .48; }
.logout-action { border: 2rpx solid var(--brand-danger); background: #FFFFFF; color: var(--brand-danger); }
```

Register `pages/account-settings/index` in `app.json` at the location asserted by `tabbar.test.js`. Do not alter the native tabBar list.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```powershell
cd wx_app
node --import tsx --test tests/pages/account-settings-runtime.test.js tests/pages/tabbar.test.js
npm run typecheck
```

Expected: focused tests PASS and TypeScript exits 0.

- [ ] **Step 9: Commit Task 3**

```powershell
git add -- wx_app/miniprogram/app.json wx_app/miniprogram/pages/account-settings wx_app/tests/pages/account-settings-runtime.test.js wx_app/tests/pages/tabbar.test.js
git diff --cached --check
git commit -m "feat: add native account settings page"
```

---

### Task 4: Full Regression, Static Validation And Cleanup

**Files:**
- Verify: `wx_app/miniprogram/app.json`
- Verify: `wx_app/miniprogram/pages/profile/**`
- Verify: `wx_app/miniprogram/pages/account-settings/**`
- Verify: `wx_app/tests/**`

**Interfaces:**
- Consumes: all deliverables from Tasks 1-3.
- Produces: verified working tree and an explicit list of any checks that require WeChat Developer Tools.

- [ ] **Step 1: Run the complete Mini Program test suite**

Run:

```powershell
cd wx_app
npm test
```

Expected: all tests PASS, zero failures.

- [ ] **Step 2: Run type checking**

Run:

```powershell
cd wx_app
npm run typecheck
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 3: Validate JSON, routes, resources and WXML handlers**

Perform read-only checks that prove:

- Every JSON under the project, excluding `.git` and `node_modules`, parses with `System.Text.Json.JsonDocument.Parse`.
- All seven paths in `app.json.pages` have matching WXML and JSON files.
- The four native tabBar icon paths exist.
- Every `bind*`/`catch*` handler in profile and account settings WXML exists in its page JS, including `async` method declarations.
- Each page-level navigation title contains “羽球拍档”.

Expected: no missing page, resource, handler or brand title.

- [ ] **Step 4: Check WeChat Developer Tools availability and perform visual QA when possible**

If the CLI or Developer Tools are available, compile and visually inspect:

- Logged-in and logged-out profile header.
- Two top-right icon buttons and 88rpx touch areas.
- No-task, loading, analytics-unavailable and complete 3×3 career states.
- Narrow phone, common full-screen phone and large text.
- Account ID overflow, phone replacement, disabled unavailable controls and logout confirmation.
- Bottom safe area and tabBar spacing.

Do not upload or publish. If Developer Tools are unavailable, report the visual checks as unexecuted instead of claiming they passed.

- [ ] **Step 5: Inspect Git scope and clean only generated residue**

Run:

```powershell
git diff --check
git status --short
```

Confirm only planned paths changed. Remove only caches or temporary directories created by these tests; preserve pre-existing untracked files and unrelated Python caches.

- [ ] **Step 6: Commit validation fixes only if necessary**

If validation requires a code correction, stage only its exact paths and commit:

```powershell
git add -- wx_app/miniprogram/app.json wx_app/miniprogram/pages/profile/index.js wx_app/miniprogram/pages/profile/index.wxml wx_app/miniprogram/pages/profile/index.wxss wx_app/miniprogram/pages/account-settings wx_app/tests/pages/profile-runtime.test.js wx_app/tests/pages/account-settings-runtime.test.js wx_app/tests/pages/tabbar.test.js
git diff --cached --check
git commit -m "fix: address profile settings verification"
```

If no correction is needed, do not create an empty commit.
