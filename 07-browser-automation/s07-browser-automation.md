# 第 07 节：浏览器自动化 (Browser Automation)

> "互联网是人类有史以来最大的数据库——但 90% 的数据锁在 JavaScript 渲染的页面里，HTTP 请求拿不到。"

## 本节改动全景

相比第 06 节，本节的改动集中在工具层，状态管理与 Agent 主循环**完全不变**：

| 改动点 | 第 06 节 | 第 07 节 |
|--------|---------|---------|
| 工具集 | shell、file R/W | + `browser_navigate` / `browser_content` / `browser_screenshot` / `browser_screenshot_annotated` / `browser_click` / `browser_type` / `browser_key` / `browser_scroll` |
| LLM 输入格式 | 纯文本 `string` | + `ContentBlock[]`（图像 base64，Vision 模式） |
| HTML 处理 | 无 | 精简管道：去噪 → 语义提取 → 截断 |
| 浏览器隔离 | 无 | `BrowserContext` per session（独立 cookie/storage） |
| Agent 主循环 | 不变 | **不变** |
| 状态持久化 | 不变 | **不变** |

**这一节的核心设计思想**：浏览器只是另一种工具——Agent 主循环不感知"这是浏览器调用"，照常 `{"action":"browser_content"}` 发起；工具层封装了所有的 Playwright 细节。

---

## 为什么需要浏览器工具

前 6 节的 Agent 只能操作本地文件和 shell 命令。但真实任务中，大量信息锁在 web 上：

```
帮我完成这个任务：
  1. 查 competitor.com 上 Pro 套餐的最新定价   ← HTTP 拿不到（SPA 渲染）
  2. 填写内部报销表单并提交                   ← 需要 JS 事件
  3. 截图证明提交成功，附在工作日志里          ← 需要真实截图
  4. 把定价写入 price_report.md
```

步骤 1-3 前 6 节全部做不到。

### HTTP 请求 vs 真实浏览器

```
HTTP 请求                          真实浏览器（Playwright）
─────────────────────              ─────────────────────────
GET /page → 初始 HTML              ① 加载初始 HTML
  ↓                                ② 执行 JavaScript
  HTML 里全是 <div id="app"></div>  ③ 触发 Ajax / fetch
  （内容在 JS 里，没有）            ④ 等待 DOM 稳定
                                   ⑤ 返回完整渲染结果 ✓
```

典型失败案例：
- **SPA**（React/Vue/Angular）：内容全靠 JS 填充，GET 到的是空壳
- **登录墙**：需要 Cookie/Session，`fetch` 无法带 UI 登录流程
- **无限滚动**：内容在 scroll 事件后才加载
- **验证码 / CAPTCHA**：需要真实浏览器环境才能通过

---

## 1. 两种"看懂"网页的方式

面对一个渲染完成的页面，Agent 有两条路：

```
渲染完成的页面
      │
      ├── DOM 文本模式 ──► page.content() → distillHTML() → 字符串 → LLM
      │
      └── 视觉截图模式 ──► page.screenshot() → base64 → ContentBlock[] → LLM
```

| 维度 | DOM 文本模式 | 视觉截图模式 |
|------|-------------|-------------|
| **Token 消耗** | 低（精简后 1-3K token） | 高（1张图 ≈ 800-1200 token） |
| **信息完整度** | 文本/链接完整，布局丢失 | 布局/颜色/图标/渐变可见 |
| **适用场景** | 内容提取、表单定位、链接抓取 | 验证码识别、图表理解、UI 布局判断 |
| **动态内容** | 需等待 JS 渲染完成 | 截图天然是渲染后结果 |
| **可交互性** | 可精确提取 `input[name]`、`button` | 只能描述，无法直接获取 selector |

**实践原则**：优先用 DOM 文本模式（省 Token）；遇到"用文字描述不清楚的布局"或"需要识别图形内容"时，切换到视觉截图模式。

---

## 2. HTML 精简 (HTML Distillation)

### 问题：原始 HTML 无法直接喂给 LLM

```
https://news.ycombinator.com 原始 HTML：约 80KB / ~20000 token
                                        ↑
                              Claude 单次限制 200K token，
                              但每次调用按 token 计费，
                              塞满整个页面性价比极低
```

原始 HTML 的噪音来源：

```html
<!-- 这些对 LLM 毫无用处 -->
<script>window.__INITIAL_STATE__ = {"user":null, ...}</script>
<style>.btn-primary { background: linear-gradient... }</style>
<meta name="csrf-token" content="abc123">
<link rel="preload" href="/fonts/inter.woff2">
<div class="ad-banner" data-slot="top-728x90">...</div>
```

### 精简管道

```typescript
function distillHTML(html: string, maxChars = 8000, offsetChars = 0): string {
  let result = html;

  // 第一步：删除完全无用的块级标签（含内容）
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // 第二步：删除无语义的元数据标签（自闭合）
  result = result.replace(/<(meta|link|svg|path|polygon)\b[^>]*\/?>/gi, '');

  // 第三步：去除所有属性，只保留语义必需的
  //   a → 保留 href        input → 保留 name/type/value/placeholder
  //   button → 保留 type   img → 保留 alt
  result = result.replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, '<a href="$1">');
  result = result.replace(/<input\b[^>]*(name|type|placeholder|value)[^>]*>/gi, (m) => {
    const attrs = ['name', 'type', 'placeholder', 'value']
      .map(a => { const match = m.match(new RegExp(`${a}="([^"]*)"`)); return match ? `${a}="${match[1]}"` : ''; })
      .filter(Boolean).join(' ');
    return `<input ${attrs}>`;
  });
  result = result.replace(/<(?!\/?(a|button|input|select|option|h[1-6]|p|li|ul|ol|td|th|tr|table|label|form|main|article|section|nav|header|footer|title)\b)[^>]+>/gi, '');

  // 第四步：折叠多余空白
  result = result.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // 第五步：应用 offset，然后截断
  if (offsetChars > 0) result = result.slice(offsetChars);
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + `\n[内容已截断，共约 ${offsetChars + result.length} 字符；如需继续请使用 browser_content 并设置 offset=${offsetChars + maxChars}]`;
  }

  return result;
}
```

精简效果：

```
原始 HTML：82,451 字符 (~20K token)
精简后：   4,830 字符  (~1.2K token)   → 节省 94%
```

### 进阶：Accessibility Tree

Playwright 内置 `page.accessibility.snapshot()` 返回结构化的可访问性树，比 HTML 更紧凑、语义更强：

```typescript
const snapshot = await page.accessibility.snapshot();
// 返回：
{
  role: 'WebArea',
  name: 'Hacker News',
  children: [
    { role: 'link', name: 'Hacker News', url: '/' },
    { role: 'link', name: '1. Show HN: xclaw - build your own agent' },
    { role: 'link', name: '2. Ask HN: best practices for LLM agents' },
    // ...
  ]
}
```

适合需要"精确定位可交互元素"的场景（点击、填表），不适合需要"理解文本内容"的场景。

### 可交互元素定位（Locator ID）

Accessibility Tree 仍然依赖元素的文本标签来定位，遇到没有文字的图标按钮或同名元素时会失效。更稳健的方案：**在精简管道末尾为每个可操作节点注入唯一 ID**。

```typescript
// 第六步（追加到 distillHTML 末尾）：为可交互元素注入唯一编号
// 在真实 DOM 上操作（page.evaluate）以支持动态渲染的 ARIA 组件
async function injectLocatorIdsIntoDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    let id = 0;
    // a/button/input/select 是经典可交互元素
    // td[role="gridcell"]  覆盖日历、数据表格（WAI-ARIA 标准）
    // li[role="option"]    覆盖 combobox/listbox 下拉选项（WAI-ARIA 标准）
    document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]')
      .forEach(el => el.setAttribute('data-agent-id', String(++id)));
  });
}
```

> **为什么扩展到 ARIA 角色**：`td[role="gridcell"]` 是日历、数据网格的标准角色；`li[role="option"]` 是 combobox 自动补全下拉的标准角色。不加这两类，Agent 看到的日历格子和下拉选项都没有 `data-agent-id`，只能用 CSS 选择器，极易失效。

精简 + 注入后的输出示例：

```html
<a data-agent-id="1" href="/login">登录</a>
<button data-agent-id="2">搜索</button>
<input data-agent-id="3" name="q" placeholder="输入关键词">
<select data-agent-id="4" name="city">
  <option>上海</option>
  <option>北京</option>
</select>
```

Agent 工具调用从"猜选择器"变为"按编号操作"：

```
❌ 脆弱：{"action":"browser_click","selector":"div.search-bar > button.btn-primary:nth-child(2)"}
✅ 稳健：{"action":"browser_click","agent_id":"2"}
```

`browser_click` 和 `browser_type` 工具同时支持 `selector` 和 `agent_id` 两种参数，优先使用 `agent_id`：

```typescript
// tools.ts 中 browser_click 的实现逻辑（含导航等待）
const locator = params['agent_id']
  ? `[data-agent-id="${params['agent_id']}"]`
  : params['selector']!;

const urlBefore = page.url();
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle', timeout: 8000 }).catch(() => null),
  page.click(locator).catch(async () => {
    // Playwright click 失败时降级到 JS click（处理被遮挡的元素）
    await page.evaluate((sel) => {
      (document.querySelector(sel) as HTMLElement | null)?.click();
    }, locator);
  }),
]);
const urlAfter = page.url();
// 无论是否跳转都刷新 data-agent-id，保证下一步操作编号正确
if (urlBefore !== urlAfter) {
  await dismissPopups(page);
  await injectLocatorIdsIntoDom(page);
  return `clicked: ${locator}\nnavigated to: ${await page.title()}\nurl: ${urlAfter}`;
}
await injectLocatorIdsIntoDom(page);
return `clicked: ${locator}\nurl: ${urlAfter}`;
```

---

## 3. 视觉理解 (Vision)

### 截图 → multimodal message

```typescript
// 工具实现
async function browserScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'png', fullPage: false });
  const base64 = buffer.toString('base64');
  // 返回给 Agent 的不是文件路径，而是可直接嵌入 message 的 base64
  return `data:image/png;base64,${base64}`;
}
```

Agent 把截图结果放进下一轮 LLM 调用时，message 格式从纯文本变为 `ContentBlock[]`：

```typescript
// Claude API 的 multimodal 格式
const message: Message = {
  role: 'user',
  content: [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: base64Data,           // 不含 "data:image/png;base64," 前缀
      },
    },
    {
      type: 'text',
      text: 'tool output:\n[截图已附上] 页面当前状态如上图，请判断下一步操作。',
    },
  ],
};
```

```typescript
// OpenAI API 的 multimodal 格式（对比）
const message = {
  role: 'user',
  content: [
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${base64Data}` },
    },
    { type: 'text', text: '...' },
  ],
};
```

### Token 成本估算

| 图片尺寸 | 预计 token 消耗 |
|---------|---------------|
| 1280×800 全页截图 | ≈ 1500-2000 token |
| 1280×800 视口截图 | ≈ 800-1200 token |
| 640×400 压缩截图 | ≈ 400-600 token |

**成本控制建议**：
- 非必要不截图，优先用 `browser_content` 获取文本
- 截图前先 `browser_scroll` 定位到关键区域，避免全页截图
- 可配置 `{ clip: { x, y, width, height } }` 只截取关注区域

### 带标注的截图（Annotated Screenshot）

当 HTML 结构被混淆、或需要让 LLM 直接判断"点哪里"时，在截图上叠加编号红框比纯截图更有效：

```typescript
// browser_screenshot_annotated 工具实现
async function screenshotWithBoundingBoxes(page: Page): Promise<string> {
  // 1. 收集所有可交互元素的屏幕坐标（与 injectLocatorIdsIntoDom 选择器一致）
  const elements = await page.evaluate(() => {
    return [...document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]')]
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        const label = (el.textContent?.trim().slice(0, 15) ||
                       el.getAttribute('placeholder') ||
                       el.getAttribute('aria-label') || '').trim();
        return { id: i + 1, x: r.x, y: r.y, w: r.width, h: r.height, label };
      })
      .filter(e => e.w > 0 && e.h > 0); // 过滤不可见元素
  });

  // 2. 在页面上注入临时 canvas overlay，画红框 + 编号
  await page.evaluate((elems) => {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;pointer-events:none';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d')!;
    for (const e of elems) {
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      ctx.strokeRect(e.x, e.y, e.w, e.h);
      ctx.fillStyle = 'red';
      ctx.fillRect(e.x, e.y - 16, 22, 16);
      ctx.fillStyle = 'white';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(String(e.id), e.x + 3, e.y - 3);
    }
  }, elements);

  // 3. 截图
  const buf = await page.screenshot({ type: 'png' });

  // 4. 移除 overlay（不影响后续操作）
  await page.evaluate(() => {
    document.querySelector('canvas[style*="z-index:99999"]')?.remove();
  });

  return buf.toString('base64');
}
```

输出效果与使用方式：

```
截图中：每个可点击元素被红色方框圈住，左上角显示白底红字编号 1、2、3…

Agent 看到截图后，system prompt 追加提示：
"截图中的编号对应可交互元素，请用 browser_click 的 agent_id 参数指定编号，
 用 browser_type 的 agent_id 参数指定输入框编号。"

Agent 回复：
{"action":"browser_click","agent_id":"3"}   ← 点击编号 3 的元素
{"action":"browser_type","agent_id":"5","text":"上海"}  ← 在编号 5 的输入框输入
```

| 场景 | 推荐方式 |
|------|---------|
| 标准表单（有 name/placeholder） | DOM 文本 + Locator ID |
| 图标按钮/无文字元素 | 红框截图 + agent_id |
| 复杂日历/富文本组件 | 红框截图 + 坐标 click(x, y) |
| 验证码图片 | 红框截图 → 识别 or HITL |

---

## 4. 浏览器工具集与会话隔离

### 八个工具

```typescript
// system prompt 中的工具描述
browser_navigate  { url: string }
  // 导航到指定 URL，等待页面加载完成
  // 返回：页面标题 + 当前 URL

browser_content   { mode?: "text" | "html", offset?: string }
  // 获取当前页面内容（默认 html，经精简管道处理，含 data-agent-id）
  // offset：字符偏移量，用于读取被截断的后续内容（见截断提示中的 offset= 值）
  // 返回：精简后的页面内容字符串，超出 maxContentChars 时附带 offset 提示

browser_screenshot  {}
  // 截取当前视口截图
  // 返回：base64 编码的 PNG（Agent 在下一轮 message 中附图发给 LLM）

browser_screenshot_annotated  {}
  // 截取截图并在每个可交互元素上叠加编号红框
  // 返回：base64 编码的 PNG（含红框标注）

browser_click     { agent_id?: string, selector?: string }
  // 点击元素；优先用 agent_id，点击后自动等待可能发生的导航，并刷新 data-agent-id 编号
  // 返回：点击结果（含跳转后的标题/URL，或未跳转时的当前 URL）

browser_type      { agent_id?: string, selector?: string, text: string }
  // 清空元素内容并输入 text；输入后自动刷新 data-agent-id（autocomplete 弹出后编号更新）
  // 返回：输入后元素的 value

browser_key       { key: string }
  // 按下键盘按键：Enter（确认 autocomplete 选项或提交表单）、Escape（关闭弹窗/下拉）、
  //   ArrowDown/ArrowUp（在下拉选项间导航）、Tab（切换焦点）
  // 按键后自动等待可能发生的导航，并刷新 data-agent-id 编号
  // 返回：按键结果（含跳转信息或当前 URL）

browser_scroll    { direction: "up" | "down", pixels?: number }
  // 滚动页面（默认 500px）
  // 返回：滚动后的位置信息
```

### BrowserContext 会话隔离

多用户同时使用时，每个 sessionId 必须拥有独立的浏览器上下文，否则：

```
sessionA 登录了 github.com
sessionB 打开 github.com → 自动以 sessionA 的身份登录  ← 严重安全问题
```

解决方案：`BrowserContext`（Playwright 的隔离单元，类似无痕窗口）

```typescript
class BrowserPool {
  private browser!: Browser;
  private contexts = new Map<string, { ctx: BrowserContext; page: Page }>();

  async init() {
    this.browser = await chromium.launch({ headless: true });
  }

  async getPage(sessionId: string): Promise<Page> {
    if (!this.contexts.has(sessionId)) {
      const ctx = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (compatible; xclaw-agent/1.0)',
      });
      const page = await ctx.newPage();
      this.contexts.set(sessionId, { ctx, page });
    }
    return this.contexts.get(sessionId)!.page;
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.contexts.get(sessionId);
    if (entry) {
      await entry.ctx.close();
      this.contexts.delete(sessionId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.values()].map(e => e.ctx.close().catch(() => {})));
    this.contexts.clear();
    await this.browser.close().catch(() => {});
  }
}
```

每个 `BrowserContext` 拥有独立的：
- Cookie jar
- localStorage / sessionStorage
- IndexedDB
- HTTP 缓存
- 权限授权记录

### 等待策略

浏览器工具最容易踩的坑——过早读取页面内容，JS 还没渲染完：

```typescript
// ❌ 危险：只等到 HTML 解析完，JS 还没跑
await page.goto(url, { waitUntil: 'domcontentloaded' });
const html = await page.content(); // SPA 里内容是空的

// ✅ 安全：等到网络请求都静止（SPA 加载完成的信号）
await page.goto(url, { waitUntil: 'networkidle' });
const html = await page.content(); // 内容已渲染

// ✅ 更精确：等到特定元素出现
await page.waitForSelector('.product-price', { timeout: 10000 });
```

| 等待策略 | 说明 | 适用场景 |
|---------|------|---------|
| `commit` | 收到第一个字节 | 最快，适合只需 URL 的场景 |
| `domcontentloaded` | HTML 解析完 | 静态页面 |
| `load` | 所有资源加载完 | 有图片/字体的静态页面 |
| `networkidle` | 500ms 内无新请求 | SPA / Ajax 页面（**推荐默认**） |

### HITL 集成

浏览器操作中，某些动作具有不可逆性——点击"提交"、"删除"、"支付"后无法撤回。与第 05 节 HITL 机制直接集成：

```typescript
// tools.ts 中的 browser_click 实现
async execute(sessionId: string, params: { selector: string }) {
  const destructive = DESTRUCTIVE_SELECTORS.some(pattern =>
    params.selector.match(pattern)
  );
  // "submit", "pay", "delete", "confirm", "purchase" 等触发 HITL
  const approved = await hitl.confirm(
    `browser_click ${params.selector}`,
    `即将点击页面元素，当前 URL: ${await page.url()}`,
    destructive,
  );
  if (!approved) return 'action denied by user';

  await page.click(params.selector);
  return `clicked: ${params.selector}`;
}
```

---

## 5. 动态网页交互循环 (Action-Observation Loop)

### 循环结构

浏览器操作不是"一次调用"，而是一个**多轮观察-行动循环**。Agent 主循环本身已经是循环（第 01 节），浏览器任务只是让每一轮工具调用都对应"看一眼页面、做一个动作"：

```
┌─────────────────────────────────────────────┐
│              Action-Observation Loop         │
│                                              │
│  观察 (Observe)                              │
│    browser_content → distillHTML + Locator   │
│    或 browser_screenshot → 红框截图           │
│           │                                  │
│           ▼                                  │
│  思考 (Think)                                │
│    LLM 分析：我在哪一步？下一步做什么？        │
│    输出：{"action":"browser_click","agent_id":"3"} │
│           │                                  │
│           ▼                                  │
│  行动 (Act)                                  │
│    Playwright 执行：点击 / 输入 / 滚动        │
│           │                                  │
│           ▼                                  │
│  验证 (Verify)                               │
│    再次 browser_content，检查 URL / 新元素    │
│    ├── 未变化 → 重试 or 上报错误             │
│    └── 已变化 → 进入下一轮 ──────────────────┘
└─────────────────────────────────────────────┘
```

这个循环完全由 Agent 主循环（`while(true)` + 工具调用）驱动，**无需新增代码**：
- 每次 LLM 输出工具调用 → 执行 → 结果反馈 → LLM 再决策
- `maxIterations` 作为循环上限（第 01 节原有机制）

### Smart Waiting

浏览器操作最常见的失败原因是"操作太快，页面还没反应"：

```typescript
// ❌ 危险：固定等待，在慢网络下仍然会失败
await page.click('#search-btn');
await new Promise(resolve => setTimeout(resolve, 2000));
const html = await page.content(); // 结果可能未加载完

// ✅ 安全：等待特定元素出现
await page.click('#search-btn');
await page.waitForSelector('.result-item', { timeout: 10000 });
const html = await page.content(); // 此时结果已渲染

// ✅ 安全：等待跳转完成
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle' }),
  page.click('#submit-btn'),
]);
```

| 等待方式 | 适用场景 |
|---------|---------|
| `waitForSelector(sel)` | 点击后等待新元素出现（列表、弹窗） |
| `waitForNavigation()` | 点击后等待页面跳转（登录、提交） |
| `waitForURL(pattern)` | 等待 URL 变为特定模式 |
| `networkidle` | SPA 全页加载后读取内容 |

### 异常处理：弹窗与 CAPTCHA

**随机弹窗自动关闭**（每次 `browser_navigate` 后调用）：

```typescript
async function dismissPopups(page: Page): Promise<void> {
  const candidates = [
    '[aria-label*="close"]', '[aria-label*="关闭"]',
    'button:has-text("Accept")', 'button:has-text("同意")',
    'button:has-text("Got it")', 'button:has-text("知道了")',
    '.modal-close', '.popup-close', '#cookie-accept', '#gdpr-accept',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) await el.click();
    } catch { /* 元素不存在则跳过 */ }
  }
}
```

**CAPTCHA 检测 → 触发 HITL**（复用第 05 节机制）：

```typescript
async function checkAndHandleCaptcha(page: Page, hitl: HITLConfirmer): Promise<void> {
  const captchaSelectors = [
    '[class*="captcha"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '[id*="challenge-form"]',  // Cloudflare
  ];
  for (const sel of captchaSelectors) {
    if (await page.$(sel)) {
      // 交给人类处理，等待确认后继续
      await hitl.confirm(
        'CAPTCHA detected — manual action required',
        `页面出现验证码\n当前 URL: ${page.url()}\n请在浏览器中手动完成验证后按 y 继续`,
        true, // destructive=true，强制询问
      );
      return;
    }
  }
}
```

CAPTCHA 处理流程：

```
Agent 导航到目标页面
      │
      ▼
checkAndHandleCaptcha()
      │
      ├── 无 CAPTCHA → 继续执行
      │
      └── 有 CAPTCHA → [HITL] 提示人类介入
                          │
                          ├── 用户手动完成验证，按 y
                          │       │
                          │       └── Agent 继续执行（页面已通过验证）
                          │
                          └── 超时 / 按 n → 返回错误
```

---

```
第 06 节                              第 07 节

tools.ts                              tools.ts
  ├─ shell_tool               →         ├─ shell_tool
  ├─ read_file                →         ├─ read_file
  └─ write_file               →         ├─ write_file
                                        └─ browser_tool  ← 新增（8个工具）
                                              ├─ BrowserPool（会话隔离）
                                              │    └─ BrowserContext per session
                                              ├─ distillHTML(html, maxChars, offset)
                                              │    去噪→语义提取→偏移→截断
                                              ├─ injectLocatorIdsIntoDom()
                                              │    DOM 注入（含 ARIA gridcell/option）
                                              └─ screenshot→base64（Vision）

providers/                            providers/
  Message:                    →         Message:
    role: string                          role: string
    content: string                       content: string
                                          imageURL?: string    ← Vision（Go 实现）
                                          // Node.js: content: string | ContentBlock[]

index.ts                              index.ts
  agent + gateway             →         agent + gateway（不变）
                                        + browserPool.init()
                                        + SIGINT: browserPool.closeAll()

增加能力：
  静态页面  → browser_navigate + browser_content（DOM 文本模式）
  SPA      → waitUntil: networkidle 等待渲染
  表单填写  → browser_type + browser_click（HITL 拦截敏感点击）
  视觉任务  → browser_screenshot → Vision multimodal message
  多用户    → BrowserContext 隔离，cookie 不互串
  精准操作  → Locator ID（data-agent-id）代替脆弱 CSS 选择器
  ARIA 组件 → td[role="gridcell"]日历 + li[role="option"]下拉 获得 agent_id
  视觉定位  → 红框截图标注可交互元素，LLM 按编号点击
  键盘交互  → browser_key：Enter/Escape/ArrowDown 等键盘事件
  长内容    → browser_content offset 参数分页读取超大 DOM
  长流程    → Action-Observation Loop，自动弹窗关闭 + CAPTCHA→HITL
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **HTTP vs 真实浏览器** | HTTP 只拿初始 HTML；真实浏览器执行 JS、处理 Cookie、等待 Ajax，SPA 必须用浏览器 |
| **DOM 文本 vs Vision** | DOM 文本省 Token 适合内容提取；Vision 保留布局适合 UI 理解，两者互补不替代 |
| **HTML 精简管道** | 去除 script/style/注释 → 只保留语义标签 → 截断；节省 90%+ Token |
| **Locator ID 注入** | 精简后在真实 DOM 上为 `a/button/input/select/td[role="gridcell"]/li[role="option"]` 注入 `data-agent-id`；覆盖标准 ARIA 日历格子和下拉选项 |
| **Accessibility Tree** | `page.accessibility.snapshot()` 返回结构化树，比 HTML 更紧凑，适合精确定位交互元素 |
| **BrowserContext 隔离** | 每 session 独立 context，cookie/storage/缓存全部隔离，防止用户登录态互串 |
| **waitUntil 策略** | 静态页面用 `domcontentloaded`；SPA 必须用 `networkidle` 等 JS 渲染完毕 |
| **Vision Token 成本** | 1 张视口截图 ≈ 800-1200 token，约为 1K 字文本的 3-5 倍，仅必要时使用 |
| **Bounding Box 标注** | canvas overlay 在截图上画编号红框；适合图标按钮、日历等无文字可交互元素 |
| **multimodal message 格式** | Node.js: `content: string \| ContentBlock[]`，Claude 用 `source.type:'base64'`，OpenAI 用 `image_url.url`；Go: `Message.ImageURL` 独立字段，provider 层各自拼装多模态块 |
| **截图历史管理** | 截图 base64 不写入消息历史（防上下文溢出）；历史中只存 `[screenshot]` 占位符，当轮 LLM 调用通过独立 vision 字段接收图像 |
| **Action-Observation Loop** | 观察→思考→行动→验证的多轮循环；由 Agent 主循环驱动，`maxIterations` 控制上限 |
| **Smart Waiting** | `waitForSelector` / `waitForNavigation` 比固定 sleep 更可靠；`browser_click` 内置 `Promise.all([waitForNavigation, click])` 模式，点击提交按钮自动等待跳转 |
| **弹窗自动关闭** | 导航后扫描常见 close/accept 按钮并点击；处理 cookie 通知、广告遮罩 |
| **CAPTCHA → HITL** | 检测 recaptcha/hcaptcha/Cloudflare challenge；触发 HITL 让人类介入，完成后 Agent 继续 |
| **HITL 与浏览器结合** | 点击 submit/pay/delete 等触发 HITL 确认；与第 05 节 HITL 机制完全复用，无需新增代码 |
| **长内容分页读取** | `page.content()` 始终返回完整 DOM（不受滚动影响）；用 `browser_content` 的 `offset` 参数分段读取超大页面，截断提示中含 `offset=N` 下一段起点 |
| **键盘交互** | `browser_key` 工具处理 autocomplete 的 `ArrowDown`+`Enter` 确认、表单 `Enter` 提交、弹窗 `Escape` 关闭等键盘场景 |

---

## 试一试

```bash
cd sections/07-browser-automation/nodejs
cp .env.example .env
# 确认 .env 中 API_KEY 正确
npm install
npx playwright install chromium
npm start
```

**Terminal 2（CLI 客户端）**

```bash
node --env-file=.env src/cli.ts
```

### 验证 DOM 文本模式

```
You: 打开 https://example.com 并告诉我页面的主标题和主要内容

xclaw uses [browser_navigate]: {"url":"https://example.com"}
xclaw uses [browser_content]: {"mode":"text"}
xclaw: 页面标题是 "Example Domain"，主要内容为：
       "This domain is for use in illustrative examples..."
```

### 验证视觉截图模式

```
You: 截图 https://news.ycombinator.com 并描述首页排版

xclaw uses [browser_navigate]: {"url":"https://news.ycombinator.com"}
xclaw uses [browser_screenshot]: {}
xclaw: [附图] 页面是橙色顶栏的新闻聚合网站，
       左侧有编号排列的文章标题，右侧显示积分和评论数...
```

### 验证表单填写（HITL 拦截）

```
You: 在 https://httpbin.org/forms/post 填写 custname 为 "xclaw" 并提交

xclaw uses [browser_navigate]: {"url":"https://httpbin.org/forms/post"}
xclaw uses [browser_type]: {"selector":"input[name=custname]","text":"xclaw"}

[HITL] browser_click input[type=submit]
即将点击页面元素，当前 URL: https://httpbin.org/forms/post
Approve? [y/N] (timeout 30s, default N) y

xclaw uses [browser_click]: {"selector":"input[type=submit]"}
xclaw: 表单已提交，页面返回了 POST 请求的 JSON 响应，
       custname 字段值为 "xclaw" ✓
```

### 验证会话隔离

```bash
# 两个 CLI，两个不同 sessionId，同时访问需要登录的页面
# session A 登录后，session B 应看到未登录状态
# 验证：两个 browser_content 返回不同的页面内容
```

### 进阶验证：端到端酒店搜索

演示 Locator ID + ARIA 选择器 + 导航等待 + offset 分页读取的完整协作：

```
You: 去 https://www.booking.com，搜索"上海"，入住明天退房后天，帮我找价格最低的酒店

xclaw uses [browser_navigate]: {"url":"https://www.booking.com"}
  → 自动关闭 cookie 弹窗（dismissPopups 检测到同意按钮并点击）

xclaw uses [browser_content]: {"mode":"html"}
  → distillHTML 精简，injectLocatorIdsIntoDom 注入编号（含 li[role="option"]）
  → 返回：<input data-agent-id="1" placeholder="目的地、住处名称">

xclaw uses [browser_type]: {"agent_id":"1","text":"Shanghai"}
  → 输入后 autocomplete 弹出，DOM 更新，injectLocatorIdsIntoDom 自动刷新编号
  → li[role="option"] 获得新的 data-agent-id

xclaw uses [browser_click]: {"agent_id":"3"}   ← 点击 autocomplete 第一个选项"上海，中国"
  → Promise.all([waitForNavigation, click])：点击触发地点确认但未跳转，8s 超时后继续
  → injectLocatorIdsIntoDom 再次刷新

xclaw uses [browser_screenshot_annotated]: {}
  → 日历弹出，td[role="gridcell"] 获得 data-agent-id，截图上红框标注日期格子
  → 截图可见：编号 12 = 明天日期，编号 13 = 后天日期

xclaw uses [browser_click]: {"agent_id":"12"}  ← 点击入住日期（明天）
xclaw uses [browser_click]: {"agent_id":"13"}  ← 点击退房日期（后天）
xclaw uses [browser_click]: {"agent_id":"7"}   ← 点击"搜索"按钮
  → Promise.all([waitForNavigation, click])：等待 networkidle，URL 变为搜索结果页
  → dismissPopups + injectLocatorIdsIntoDom

xclaw uses [browser_content]: {"mode":"html"}
  → 返回约 20000 字符，主要是筛选栏
  → 末尾提示：[内容已截断，共约 62000 字符；如需继续请使用 browser_content 并设置 offset=20000]

xclaw uses [browser_content]: {"mode":"html","offset":"40000"}
  → 跳过筛选栏，直接读到酒店列表区域
  → 提取酒店名称、价格、评分

xclaw: 找到最低价酒店：
       「Hi Cozy International Hostel（嗨享客栈·国际青年旅舍）」
       每晚 ¥375，评分 8.3 / 10
       https://www.booking.com/hotel/cn/...
```

关键技术点总结：

| 步骤 | 技术点 |
|------|-------|
| 弹窗关闭 | `dismissPopups` 自动处理 cookie 同意 |
| 文本框定位 | Locator ID → `agent_id:"1"` 代替 CSS 选择器 |
| Autocomplete 选项 | `li[role="option"]` 获得 `data-agent-id`，输入后自动刷新编号 |
| 日历选择 | `td[role="gridcell"]` 获得 `data-agent-id`，截图可见红框编号 |
| 搜索提交 | `Promise.all([waitForNavigation, click])` 等待跳转完成 |
| 超大 DOM 读取 | `offset` 参数分页：offset=0（筛选栏）→ offset=40000（酒店列表）|
| 价格提取 | `browser_content: html` → 精简后 LLM 提取结构化数据 |
