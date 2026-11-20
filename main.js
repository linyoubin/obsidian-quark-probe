/*
 * Quark Set-Cookie Probe — 一次性探针插件（无构建、无依赖、纯 CommonJS）
 *
 * 目的：只回答一个问题——Obsidian 的 requestUrl 在响应 headers 里
 *       到底给不给 set-cookie？
 *
 * 用法：装进 <vault>/.obsidian/plugins/quark-probe/ → 启用 →
 *       命令面板执行「Probe: 检查 set-cookie 头」→ Ctrl+Shift+I 看 console。
 *
 * 安全：只发 3 个 GET；不带任何 Cookie / token / 账号信息；
 *       不调用任何夸克登录或授权接口。
 */

const {
  Plugin,
  Notice,
  Platform,
  apiVersion,
  requestUrl,
} = require("obsidian");

// 三个目标：任一不可达时自动用 fallbackUrl 重试一次（README 有记录）
const TARGETS = [
  {
    idx: 1,
    name: "baidu",
    url: "https://www.baidu.com",
    fallbackUrl: "https://www.bing.com",
    note: "国内可达，首页通常 200 且下发 Set-Cookie",
  },
  {
    idx: 2,
    name: "httpbin-echo",
    url: "https://httpbin.org/response-headers?Set-Cookie=probe%3D1",
    fallbackUrl: "https://httpbin.org/get?probe=1",
    note: "回显服务，理论上把 Set-Cookie=probe=1 原样写回",
  },
  {
    idx: 3,
    name: "quark-account-info",
    url: "https://pan.quark.cn/account/info",
    fallbackUrl: "https://pan.quark.cn/",
    note: "夸克真实端点，无登录态时预期 302（若被自动跟随则看到 200 登录页）",
  },
];

function truncate(s, n) {
  const str = String(s == null ? "" : s);
  return str.length > n ? str.slice(0, n) + "…(+" + (str.length - n) + ")" : str;
}

// 从 headers 里找 set-cookie（大小写不敏感，兼容数组值）
function analyzeHeaders(headers) {
  const h = headers && typeof headers === "object" ? headers : {};
  const keys = Object.keys(h);
  const hits = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.toLowerCase().indexOf("set-cookie") !== 0) continue;
    const v = h[k];
    if (Array.isArray(v)) {
      for (let j = 0; j < v.length; j++) hits.push(String(v[j]));
    } else {
      hits.push(String(v));
    }
  }
  const has = hits.length > 0;
  return {
    headerKeys: keys,
    hasSetCookie: has,
    setCookieCount: hits.length,
    setCookieValue: has ? truncate(hits[0], 80) : "(无)",
    rawHits: hits,
  };
}

class QuarkSetCookieProbe extends Plugin {
  async onload() {
    this.addCommand({
      id: "probe-set-cookie",
      name: "Probe: 检查 set-cookie 头",
      callback: () =>
        // 命令回调也必须兜住，避免 command 抛错变成「命令无效」；
        // 返回 Promise，便于宿主/测试等待探测真正结束
        this.runProbe().catch((e) => {
          const msg = e && e.message ? e.message : String(e);
          console.error("[quark-probe] FATAL:", e);
          new Notice("Probe 失败（未预期异常）：" + msg);
        }),
    });
    console.log(
      "[quark-probe] loaded. apiVersion=" +
        String(apiVersion) +
        " platform=" +
        (Platform.isMobileApp ? "mobile" : Platform.isDesktopApp ? "desktop" : "unknown")
    );
  }

  onunload() {
    console.log("[quark-probe] unloaded");
  }

  async requestOnce(url) {
    // throw:false → 4xx/5xx 不抛，能拿到 status 与 headers
    const res = await requestUrl({
      url: url,
      method: "GET",
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
      throw: false,
    });
    return res || {};
  }

  async runProbe() {
    try {
      const env =
        (Platform.isMobileApp ? "mobile" : Platform.isDesktopApp ? "desktop" : "unknown") +
        " / apiVersion=" +
        String(apiVersion);
      console.log("================ quark-probe START ================");
      console.log("env: " + env);
      console.log("targets: " + TARGETS.length + " (GET only, no Cookie header sent)");
      console.log("tip: 判定看下面每个目标的 hasSetCookie 行，不必读原始 JSON");
      console.log("==================================================");

      const results = [];
      for (let i = 0; i < TARGETS.length; i++) {
        const t = TARGETS[i];
        let usedUrl = t.url;
        let res = null;
        let failed = false;
        let errMsg = "";

        console.log("");
        console.log("==== [" + t.idx + "/" + TARGETS.length + "] " + t.name + " ====");
        console.log("url: " + usedUrl);
        console.log("note: " + t.note);

        try {
          res = await this.requestOnce(usedUrl);
        } catch (e) {
          errMsg = e && e.message ? e.message : String(e);
          console.warn("[quark-probe] primary failed: " + errMsg + " → fallback " + t.fallbackUrl);
          usedUrl = t.fallbackUrl;
          console.log("fallbackUrl: " + usedUrl);
          try {
            res = await this.requestOnce(usedUrl);
          } catch (e2) {
            failed = true;
            errMsg = (e2 && e2.message ? e2.message : String(e2)) || errMsg;
          }
        }

        if (failed || !res) {
          console.log("status: (请求失败)");
          console.log("error: " + errMsg);
          console.log("hasSetCookie: false");
          console.log("setCookieValue: (无)");
          console.log("NOTE: 这次 false 是请求失败，不是证据，请按 README 换备选目标重跑");
          results.push({
            idx: t.idx,
            name: t.name,
            url: usedUrl,
            status: null,
            hasSetCookie: false,
            setCookieValue: "(无)",
            count: 0,
            requestFailed: true,
            error: errMsg,
            headerKeys: [],
            headers: {},
          });
          continue;
        }

        const a = analyzeHeaders(res.headers);
        const status = typeof res.status === "number" ? res.status : -1;

        console.log("status: " + status);
        console.log("headerKeys: " + JSON.stringify(a.headerKeys));
        console.log("headers JSON:");
        console.log(JSON.stringify(res.headers || {}, null, 2));
        console.log("hasSetCookie: " + (a.hasSetCookie ? "true" : "false"));
        console.log("setCookieValue: " + a.setCookieValue);
        console.log("setCookieCount: " + a.setCookieCount);

        results.push({
          idx: t.idx,
          name: t.name,
          url: usedUrl,
          status: status,
          hasSetCookie: a.hasSetCookie,
          setCookieValue: a.setCookieValue,
          count: a.setCookieCount,
          requestFailed: false,
          error: "",
          headerKeys: a.headerKeys,
          headers: res.headers || {},
        });
      }

      this.printSummary(results);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error("[quark-probe] probe aborted:", e);
      console.log("hasSetCookie: false");
      console.log("setCookieValue: (无)");
      new Notice("Probe 中止：" + msg);
    }
  }

  printSummary(results) {
    const ok = results.filter((r) => !r.requestFailed);
    const withCookie = ok.filter((r) => r.hasSetCookie);

    console.log("");
    console.log("========== 结论（只看这三行） ==========");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const tail = r.requestFailed ? "  [请求失败，不作数]" : "  status=" + r.status;
      console.log(
        "[" + r.idx + "] " + r.name + "  hasSetCookie: " + (r.hasSetCookie ? "true" : "false") +
          "  setCookieValue: " + r.setCookieValue + tail
      );
    }
    console.log(
      "观测计数: 成功 " + ok.length + "/" + results.length +
        " 个目标；其中 " + withCookie.length + " 个响应 headers 含 set-cookie"
    );
    console.log("注意: 仅代表本次探测在当前环境的观察，不能推断其他平台/版本的行为");

    // 便于整段复制回传的块
    console.log("");
    console.log("---------- COPY BELOW (给回执用) ----------");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log("TARGET " + r.idx + " " + r.url);
      console.log("status: " + (r.status == null ? "(请求失败)" : r.status));
      console.log("hasSetCookie: " + (r.hasSetCookie ? "true" : "false"));
      console.log("setCookieValue: " + r.setCookieValue);
      console.log("headerKeys: " + JSON.stringify(r.headerKeys));
      console.log("headers: " + JSON.stringify(r.headers || {}));
      console.log("");
    }
    console.log("---------- COPY ABOVE ----------");

    const lines = results.map(function (r) {
      return "[" + r.idx + "] " + r.name + " hasSetCookie:" + (r.hasSetCookie ? "true" : "false") +
        (r.requestFailed ? " (失败)" : "");
    });
    const summary =
      "quark-probe: " + withCookie.length + "/" + ok.length + " 个目标含 set-cookie\n" +
      lines.join("\n") +
      "\n详情看 console（Ctrl+Shift+I）";
    new Notice(summary, 20000);
  }
}

module.exports = QuarkSetCookieProbe;
