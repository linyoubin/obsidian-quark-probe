# quark-probe：Obsidian requestUrl 的 set-cookie 探针（一次性）

只回答一个问题：**Obsidian 的 `requestUrl` 响应 headers 里，到底有没有 `set-cookie`？**

这决定「手机上 Obsidian 展示二维码 → 夸克扫码 → 插件自己拿到登录 cookie」这条授权链能否在纯手机端闭合。
插件只发 3 个 GET 请求；不带任何 Cookie、token 或账号信息；不调用任何夸克登录或授权接口。

---

## 一、装到哪

把本目录（`manifest.json` + `main.js`）整体复制到：

```
<你的桌面 vault>/.obsidian/plugins/quark-probe/
```

最终路径形如：

```
D:\work\知识库\.obsidian\plugins\quark-probe\manifest.json
D:\work\知识库\.obsidian\plugins\quark-probe\main.js
```

> 必须是**桌面 vault**（手机端不是这次要测的）。目录名固定 `quark-probe`，与 `manifest.json` 的 `id` 一致。

## 二、怎么启用

1. 打开 Obsidian → 设置 → 第三方插件（Community plugins）。
2. 若「安全模式 / Restricted mode」是开着的，先关闭。
3. 在已安装插件里找到 **Quark Set-Cookie Probe**，打开开关。
4. `Ctrl+P` 打开命令面板，执行 **「Probe: 检查 set-cookie 头」**。

## 三、怎么看结果

1. `Ctrl+Shift+I` 打开开发者工具（若没反应，用菜单 视图 → 开发者工具）。
2. 切到 **Console**。
3. 找 `========== 结论（只看这三行） ==========` 这一段，每个目标一行：
   - `hasSetCookie: true` / `hasSetCookie: false`
   - `setCookieValue: <前 80 字符>`
4. 右上角还会弹一条 `Notice` 摘要，内容与结论段一致。

**不用读原始 JSON**：判定行是插件自己算好的。原始 `headers JSON` 仍会打印，只用于回传留证。

## 四、要贴回什么

从 console 里复制 **`---------- COPY BELOW ----------` 到 `---------- COPY ABOVE ----------`** 之间的全部内容（含 3 个目标的 `hasSetCookie` 行 + 完整 `headers` JSON），整段贴回即可。

贴回时请注意：

- **不要粘贴任何真实 cookie**。本探针不下发、不接收你的账号 cookie；`setCookieValue` 最多是百度匿名 cookie、`probe=1` 这类测试值。
- 也不需要贴 Obsidian 账号、设备序列号等。
- 若能顺手补一句环境（Obsidian 版本 + Windows 版本），判定更稳。

---

## 三个目标与备选

| # | 目标 | 预期 | 不可达时的备选（已内置自动重试一次） |
|---|---|---|---|
| 1 | `https://www.baidu.com` | 200，通常下发 `Set-Cookie` | `https://www.bing.com` |
| 2 | `https://httpbin.org/response-headers?Set-Cookie=probe%3D1` | 200，回显 `Set-Cookie: probe=1` | `https://httpbin.org/get?probe=1` |
| 3 | `https://pan.quark.cn/account/info` | 无登录态时 **302**（若 requestUrl 自动跟随重定向，会看到 200 登录页） | `https://pan.quark.cn/` |

- 目标 2、3 若返回 4xx/5xx，`requestUrl` 用 `throw:false` 也照样返回 status 与 headers，不算失败。
- 若某目标**网络层**就失败（DNS/超时/证书），插件会自动换备选并打印 `fallbackUrl`；仍失败则该目标标 `hasSetCookie: false (请求失败)`，并注明「这次 false 不作数」。
- 想换目标：改 `main.js` 顶部的 `TARGETS` 数组即可（无构建步骤，改完重启 Obsidian）。

## 结果怎么解读（只谈这次观测，不外推）

- **3 个目标里至少 1 个 `hasSetCookie: true`** → 说明本次环境下 `requestUrl` 的响应 headers 能看到 `set-cookie`，扫码拿 cookie 这条路在**桌面端**有观察依据；手机端是否一致**仍需在手机上重跑本探针**（`isDesktopOnly: false`，可直接装到手机 vault 再跑一次）。
- **3 个都 `false`** → 本次环境下 headers 不含 `set-cookie`，靠 `requestUrl` 读 cookie 这条路在当前环境不成立，需改走别的凭据回传方式。
- **很多 `(请求失败)`** → 先解决网络（换目标或挂代理），不要当成结论。

两种情况下本插件都只陈述「这次观察到了什么」，不推断 Obsidian 的全局行为。

## 卸载

设置 → 第三方插件 → 关闭开关，删掉 `.obsidian/plugins/quark-probe/` 目录即可。插件不写任何持久化数据（无 `saveData`、无 IndexedDB）。

## 文件清单

| 文件 | 说明 |
|---|---|
| `manifest.json` | 插件清单，`id: quark-probe`，`isDesktopOnly: false`（手机也能装） |
| `main.js` | 纯 CommonJS，只 `require("obsidian")`，无构建、无第三方依赖 |
| `versions.json` | BRAT / 社区插件版本映射：`{"0.1.0":"1.5.0"}` |
| `README.md` | 本文件 |

---

## 手机安装（BRAT）

> 用途：在 iPhone / Android 的 Obsidian 里验证 `requestUrl` 是否同样暴露 `set-cookie`。本仓库只有 `manifest.json` + `main.js`，无构建产物，BRAT 可直接装。

1. **装 BRAT**：Obsidian → 设置 → 第三方插件 → 浏览 → 搜索 `BRAT`（全名 Obsidian42 - BRAT）→ 安装并启用。
2. **加 beta 插件**：命令面板（`Ctrl+P` / 手机顶部搜索图标）执行
   **`BRAT: Add a beta plugin for testing`**
   （中文界面显示为「BRAT: 添加一个用于测试的测试版插件」，选带 "beta plugin" 的那条）。
3. **输入仓库**：粘贴 `linyoubin/obsidian-quark-probe` → 点 `Add Plugin`。BRAT 会自动从本仓库 Release 下载 `manifest.json` 与 `main.js`。
4. **启用插件**：设置 → 第三方插件 → 已安装插件里打开 **Quark Set-Cookie Probe**。
5. **跑探针**：命令面板执行 **`Probe: 检查 set-cookie 头`**。
6. **看结果**：手机上会弹一条 `Notice`，列出 `[1]/[2]/[3]` 三个目标的 `hasSetCookie:true/false` 与命中个数——这就是判定行。完整 `headers` JSON 只在桌面版 console（`Ctrl+Shift+I`）里能看到；手机端如需完整证据，可截图 Notice 或把这 3 行手抄回来。

> 提示：BRAT 装的是 Release 资产，所以**升级版本必须新打 tag + Release**；改代码不重打 tag 不会自动更新。
