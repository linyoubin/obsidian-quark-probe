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
  Modal,
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
    // 0.1.1 新增：扫码登录 spike（与探针命令完全独立，探针代码未改）
    this.addCommand({
      id: "quark-qr-login",
      name: "Quark: 扫码登录验证",
      callback: () => {
        new QuarkQrLoginModal(this.app).open();
      },
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

// ================= 0.1.1：Quark 扫码登录 spike =================
// 安全硬线：Cookie 只存 Modal 实例变量；不写插件数据文件、不写浏览器数据库、不写密钥存储；
// console / Notice / 界面都只显示 cookie 名称集合与 __pus/__puus 是否存在，不显示值。
// 命令：命令面板「Quark: 扫码登录验证」

/* VENDORED-QR-LIB
 * qrcode-generator 1.4.4 (MIT, Copyright (c) 2009 Kazuhiko Arase)
 * 上游：https://github.com/kazuhikoarase/qrcode-generator
 * 下载来源：https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
 * 仓库内独立副本：./src/vendor/qr.js（与本段逐字一致，改动需同步两处）
 */
const QRLib = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  var define = undefined;
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));

  return module.exports;
})();

const QUARK_TOKEN_URL =
  "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=";
// 0.1.4：先访问 CAS 登录页建立会话（浏览器是页面加载时就有的，我们没有 cookie jar）
const QUARK_CAS_LOGIN =
  "https://uop.quark.cn/cas/custom/login?custom_login_type=mobile&client_id=532&display=pc";
const QUARK_TICKET_URL_TOKEN =
  "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?token=";
const QUARK_TICKET_URL =
  "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2";
// 0.1.2：二维码必须带完整参数。只带 token 时夸克 App 能打开确认页，但会提示
// 「登录请求已过期」——确认页要用 client_id/ssb/uc_param_str/uc_biz_str 绑定这次登录请求。
// uc_biz_str 按官方 url.format 的效果逐值 percent-encode（|→%7C、@→%40、:→%3A），
// 与 pan.quark.cn 登录页 / QuarkPan 的实现字节一致。
const QUARK_QR_PREFIX = "https://su.quark.cn/4_eMHBJ?token=";
const QUARK_QR_UC_BIZ_STR =
  "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0";
const QUARK_QR_SUFFIX =
  "&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=" +
  encodeURIComponent(QUARK_QR_UC_BIZ_STR);
const QUARK_ACCOUNT_INFO = "https://pan.quark.cn/account/info?st=";
const QUARK_FILE_SORT =
  "https://drive-pc.quark.cn/1/clouddrive/file/sort?pdir_fid=0&_page=1&_size=20&_fetch_total=1&pr=ucpro&fr=pc";
// token TTL 实测（2026-11-20 匿名探测）：t+169s 仍 50004001，t+184s 变 50004002（Token Not Found）
// 客户端上限 180s：服务端实测 184s，提前 4s 主动停，避免「插件还在等、夸克已过期」的错位
const QR_TTL_SECONDS = 184;
const QR_TTL_MS = 180000;
const QR_POLL_MS = 2000;
// 0.1.3：与官方浏览器请求对齐的头部（官方由浏览器自动带 cookie/UA/Referer）
const QR_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const QR_REFERER = "https://pan.quark.cn/";

function qrCookiePairs(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const first = (String(list[i]).split(";")[0] || "").trim();
    if (first && first.indexOf("=") > 0) out.push(first);
  }
  return out;
}

function qrRequestId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* fallthrough */
  }
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += "0123456789abcdef".charAt(Math.floor(Math.random() * 16));
  }
  return s;
}

function qrParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

// 0.1.3：官方轮询只带 token。仅当响应不是合法 JSON 或 HTTP 4xx 时才回退旧形态
function qrIsJsonResponse(res) {
  if (!res || typeof res.status !== "number" || res.status >= 400) return false;
  try {
    const j = JSON.parse(res.text);
    return Boolean(j) && typeof j.status === "number";
  } catch (e) {
    return false;
  }
}

// 把单个 set-cookie 值拆成多条（平台可能把多条合并成 ", " 分隔的一串）
function qrSplitSetCookieValue(v) {
  if (Array.isArray(v)) {
    const arr = [];
    for (let i = 0; i < v.length; i++) arr.push(String(v[i]));
    return arr;
  }
  const s = String(v == null ? "" : v);
  // 仅当逗号后紧跟 name= 时才认为是新的一条（避免把 Expires 里的逗号切坏）
  return s.split(/,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}

// 响应头里的 set-cookie（大小写不敏感；数组与逗号串都正确拆）
function qrSetCookieList(headers) {
  const out = [];
  if (!headers || typeof headers !== "object") return out;
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase().indexOf("set-cookie") !== 0) continue;
    const parts = qrSplitSetCookieValue(headers[keys[i]]);
    for (let j = 0; j < parts.length; j++) out.push(parts[j]);
  }
  return out;
}

function qrCookieNameOf(pair) {
  const i = String(pair).indexOf("=");
  return i > 0 ? String(pair).slice(0, i).trim() : "";
}

// 按 name 合并（后来的覆盖先来的），保证同一 cookie 只出现一次
function qrMergeCookies(base, add) {
  const map = new Map();
  for (let i = 0; i < base.length; i++) {
    const n = qrCookieNameOf(base[i]);
    if (n) map.set(n, base[i]);
  }
  for (let i = 0; i < add.length; i++) {
    const n = qrCookieNameOf(add[i]);
    if (n) map.set(n, add[i]);
  }
  return Array.from(map.values());
}

function qrCookieNames(list) {
  const names = [];
  for (let i = 0; i < list.length; i++) {
    const first = String(list[i]).split(";")[0] || "";
    const eq = first.indexOf("=");
    if (eq > 0) names.push(first.slice(0, eq).trim());
  }
  return names;
}

// 组装成可放进请求头的 Cookie 字符串（只在内存里）
function qrCookieHeader(list) {
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const first = (String(list[i]).split(";")[0] || "").trim();
    if (first) parts.push(first);
  }
  return parts.join("; ");
}

function qrPickTicket(j) {
  const d = (j && j.data) || {};
  const m = d.members || {};
  return m.service_ticket || d.service_ticket || m.ticket || d.ticket || "";
}

class QuarkQrLoginModal extends Modal {
  constructor(app) {
    super(app);
    this.token = null;
    this.rid = null;
    this.timer = null;
    this.countTimer = null;
    this.startedAt = 0;
    this.busy = false;
    this.finished = false;
    this.cookie = null; // 仅内存，关闭即丢
    this.onVis = null;
    this.timeline = []; // 只含 status/message 与事件名，不含 token/cookie 值
    this.timelineEl = null;
    this.casCookies = []; // CAS 会话 cookie + token 响应 cookie（k=v），只进内存
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.createEl("h3", { text: "Quark: 扫码登录验证" });
    this.statusEl = c.createEl("div", { text: "正在获取二维码…" });
    this.qrEl = c.createEl("div");
    this.detailEl = c.createEl("div", { text: "" });
    this.countdownEl = c.createEl("div", { text: "" });
    const tlBtn = c.createEl("button", { text: "显示时间线" });
    this.timelineEl = c.createEl("pre", { text: "" });
    this.timelineEl.style.display = "none";
    this.timelineEl.style.whiteSpace = "pre-wrap";
    this.timelineEl.style.fontSize = "12px";
    this.timelineEl.style.maxHeight = "200px";
    this.timelineEl.style.overflow = "auto";
    tlBtn.addEventListener("click", () => {
      const show = this.timelineEl.style.display === "none";
      this.timelineEl.style.display = show ? "block" : "none";
      tlBtn.setText(show ? "隐藏时间线" : "显示时间线");
      if (show) this.renderTimeline();
    });
    const cpBtn = c.createEl("button", { text: "复制时间线" });
    cpBtn.addEventListener("click", () => this.copyTimeline());
    const btn = c.createEl("button", { text: "重新生成" });
    btn.addEventListener("click", () => {
      this.finished = false;
      this.cookie = null;
      this.start();
    });
    this.onVis = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        this.logEvent("visibilitychange→visible");
      } else {
        this.logEvent("visibilitychange→hidden");
        return;
      }
      if (this.finished || !this.token) return;
      // 从夸克 App 回来：立即补一次轮询，并重置 2 秒计时
      this.tick();
      this.restartTimer();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVis);
    }
    this.start();
  }

  onClose() {
    this.stop();
    this.cookie = null;
    this.token = null;
    if (this.onVis && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVis);
    }
    this.onVis = null;
    this.contentEl.empty();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.countTimer) {
      clearInterval(this.countTimer);
      this.countTimer = null;
    }
  }

  // 剩余秒数倒计时：每秒刷新；≤30 秒变提示色
  startCountdown() {
    if (this.countTimer) {
      clearInterval(this.countTimer);
      this.countTimer = null;
    }
    const render = () => {
      if (!this.countdownEl) return;
      const left = Math.max(0, Math.ceil((QR_TTL_MS - (Date.now() - this.startedAt)) / 1000));
      const warn = left <= 30;
      this.countdownEl.setText(
        "剩余 " +
          left +
          " 秒（客户端上限 " +
          Math.round(QR_TTL_MS / 1000) +
          " 秒；token 实测有效期 " +
          QR_TTL_SECONDS +
          " 秒，提前 4 秒停）"
      );
      this.countdownEl.style.color = warn ? "#d14343" : "";
      this.countdownEl.style.fontWeight = warn ? "bold" : "";
    };
    render();
    this.countTimer = setInterval(render, 1000);
  }

  restartTimer() {
    this.stop();
    if (this.finished || !this.token) return;
    this.timer = setInterval(() => this.tick(), QR_POLL_MS);
  }

  // —— 时间线（只含 status/message 与事件名，不含 token/cookie 值）——
  logEvent(name) {
    const el = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    this.timeline.push("+" + el + "s | event | " + name);
    if (this.timeline.length > 200) this.timeline.shift();
    this.renderTimeline();
  }

  logPoll(status, message) {
    const el = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    const msg = message ? String(message).slice(0, 40) : "";
    this.timeline.push("+" + el + "s | " + status + " | " + msg);
    if (this.timeline.length > 200) this.timeline.shift();
    this.renderTimeline();
  }

  timelineText() {
    return this.timeline.join("\n");
  }

  renderTimeline() {
    if (this.timelineEl) this.timelineEl.setText(this.timelineText());
  }

  async copyTimeline() {
    const text = this.timelineText();
    let ok = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        const host = this.contentEl || (typeof document !== "undefined" && document.body);
        const ta = host.createEl("textarea");
        ta.value = text;
        ta.select();
        document.execCommand("copy");
        ta.remove();
        ok = true;
      } catch (e) {
        ok = false;
      }
    }
    new Notice(ok ? "时间线已复制（" + this.timeline.length + " 行）" : "复制失败，请展开时间线手动截图");
  }

  // 统一请求头：UA + Referer + Origin；有 CAS 会话 cookie 就带上
  authHeaders() {
    const h = {
      "User-Agent": QR_UA,
      Referer: QR_REFERER,
      Origin: "https://pan.quark.cn",
    };
    const ck =
      this.casCookies && this.casCookies.length ? this.casCookies.join("; ") : "";
    if (ck) h.Cookie = ck;
    return h;
  }

  setStatus(t) {
    if (this.statusEl) this.statusEl.setText(t);
  }

  note(t) {
    // 只允许打印状态与 cookie 名称，绝不打印值
    console.log("[quark-qr] " + t);
  }

  renderQr(payload) {
    this.qrEl.empty();
    const qr = QRLib(0, "M");
    qr.addData(payload);
    qr.make();
    const n = qr.getModuleCount();
    const scale = 6;
    const margin = 4 * scale;
    const size = n * scale + margin * 2;
    const canvas = this.qrEl.createEl("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < n; r++) {
      for (let cc = 0; cc < n; cc++) {
        if (qr.isDark(r, cc)) {
          ctx.fillRect(margin + cc * scale, margin + r * scale, scale, scale);
        }
      }
    }
    const img = this.qrEl.createEl("img");
    img.src = canvas.toDataURL("image/png");
    img.style.width = "260px";
    img.style.height = "260px";
    img.alt = "quark-login-qrcode";
    canvas.remove();
  }

  async start() {
    this.stop();
    this.finished = false;
    this.cookie = null;
    this.casCookies = [];
    this.timeline = [];
    this.renderTimeline();
    this.qrEl.empty();
    this.detailEl.setText("");
    this.setStatus("正在获取二维码 token…");
    this.rid = qrRequestId();
    try {
      // 0.1.4 步骤 1：先 GET CAS 登录页建立会话，拿 _UP_* 系列 cookie（失败不中断）
      try {
        const casRes = await requestUrl({
          url: QUARK_CAS_LOGIN,
          method: "GET",
          headers: this.authHeaders(),
          throw: false,
        });
        const casRaw = qrSetCookieList(casRes.headers);
        this.casCookies = qrMergeCookies(this.casCookies, qrCookiePairs(casRaw));
        this.logEvent("casSetCookieNames=[" + qrCookieNames(casRaw).join(",") + "]");
      } catch (e) {
        this.logEvent("casSessionFailed=" + (e && e.message ? e.message : "error"));
      }
      // 0.1.4 步骤 2：取 token（带上 CAS 会话 cookie），并继续收集响应 cookie
      const res = await requestUrl({
        url: QUARK_TOKEN_URL + encodeURIComponent(this.rid),
        method: "GET",
        headers: this.authHeaders(),
        throw: false,
      });
      const rawCookies = qrSetCookieList(res.headers);
      this.casCookies = qrMergeCookies(this.casCookies, qrCookiePairs(rawCookies));
      this.logEvent(
        "tokenRespSetCookieNames=[" + qrCookieNames(rawCookies).join(",") + "]"
      );
      this.logEvent("cookieHeaderLen=" + this.casCookies.join("; ").length);
      const j = qrParseJson(res.text);
      const token = j && j.data && j.data.members && j.data.members.token;
      if (j.status !== 2000000 || !token) {
        this.setStatus("获取二维码失败：status=" + j.status + " " + (j.message || ""));
        return;
      }
      this.token = token;
      this.startedAt = Date.now();
      this.logEvent("token created");
      const payload = QUARK_QR_PREFIX + token + QUARK_QR_SUFFIX;
      this.renderQr(payload);
      this.setStatus(
        "等待扫码：请截图，用夸克 App 识别二维码（token 实测 " +
          QR_TTL_SECONDS +
          " 秒有效；剩余秒数见下方倒计时）"
      );
      this.detailEl.setText(
        "二维码内容长度 " +
          payload.length +
          " 字符；扫码后在夸克里确认，再回到本页（切回时会立即补一次轮询）。"
      );
      this.startedAt = Date.now();
      this.startCountdown();
      this.note("qr shown, payload_len=" + payload.length);
      this.restartTimer();
    } catch (e) {
      this.setStatus("获取二维码异常：" + (e && e.message ? e.message : String(e)));
    }
  }

  async tick() {
    if (this.busy || this.finished || !this.token) return;
    if (Date.now() - this.startedAt >= QR_TTL_MS) {
      this.logEvent("expired client-side");
      this.finish(
        "插件已主动停止轮询（客户端上限 " +
          Math.round(QR_TTL_MS / 1000) +
          " 秒；服务端实测 " +
          QR_TTL_SECONDS +
          " 秒）——这是插件侧超时，不是夸克侧过期，请点「重新生成」"
      );
      return;
    }
    this.busy = true;
    try {
      const headers = this.authHeaders();
      this.logEvent(
        "pollHeaders(cookieCount=" +
          this.casCookies.length +
          ", cookieHeaderLen=" +
          this.casCookies.join("; ").length +
          ")"
      );
      let res = await requestUrl({
        url: QUARK_TICKET_URL_TOKEN + encodeURIComponent(this.token),
        method: "GET",
        headers: headers,
        throw: false,
      });
      let j = qrParseJson(res.text);
      if (!qrIsJsonResponse(res)) {
        // 官方形态不可用时回退到旧形态（同样带 cookie/UA/Referer）
        this.logEvent("pollFallback=true");
        const u2 =
          QUARK_TICKET_URL +
          "&token=" +
          encodeURIComponent(this.token) +
          "&request_id=" +
          encodeURIComponent(this.rid || "");
        res = await requestUrl({ url: u2, method: "GET", headers: headers, throw: false });
        j = qrParseJson(res.text);
      }
      const st = j.status;
      this.logPoll(st, j.message || "");
      if (st === 2000000) {
        const ticket = qrPickTicket(j);
        if (!ticket) {
          this.finish("已返回成功但未找到 service_ticket 字段，请把响应结构反馈给开发者");
          return;
        }
        await this.exchange(ticket);
        return;
      }
      if (st === 50004001) {
        this.setStatus("已获取 token，等待扫码/确认…");
        return;
      }
      if (st === 50004002) {
        this.finish(
          "夸克侧 token 已过期（50004002，实测有效期 " +
            QR_TTL_SECONDS +
            " 秒），请点「重新生成」"
        );
        return;
      }
      if (st === 50004003) {
        this.finish("扫码登录失败（50004003）");
        return;
      }
      if (st === 50004004) {
        this.finish("已在夸克端取消（50004004）");
        return;
      }
      this.setStatus("轮询中… status=" + st + (j.message ? "（" + j.message + "）" : ""));
    } catch (e) {
      this.setStatus("轮询异常：" + (e && e.message ? e.message : String(e)));
    } finally {
      this.busy = false;
    }
  }

  async exchange(ticket) {
    this.stop();
    this.setStatus("已拿到 service_ticket，正在换 Cookie…");
    try {
      const res = await requestUrl({
        url: QUARK_ACCOUNT_INFO + encodeURIComponent(ticket) + "&lw=scan",
        method: "GET",
        headers: this.authHeaders(),
        throw: false,
      });
      const raws = qrSetCookieList(res.headers);
      if (!raws.length) {
        this.finish("换 Cookie 失败：响应 headers 里没有 set-cookie");
        return;
      }
      const names = qrCookieNames(raws);
      this.cookie = qrCookieHeader(raws); // 仅内存
      const hasPus = names.indexOf("__pus") >= 0;
      const hasPuus = names.indexOf("__puus") >= 0;
      this.detailEl.setText(
        "set-cookie 条数=" +
          raws.length +
          "；名称集合=[" +
          names.join(", ") +
          "]；__pus=" +
          hasPus +
          "；__puus=" +
          hasPuus
      );
      this.note("cookie received: count=" + raws.length + " names=" + names.join(",") + " puus=" + hasPuus);
      await this.verify();
    } catch (e) {
      this.finish("换 Cookie 异常：" + (e && e.message ? e.message : String(e)));
    }
  }

  async verify() {
    this.setStatus("正在验活：GET /file/sort?pdir_fid=0 …");
    try {
      const res = await requestUrl({
        url: QUARK_FILE_SORT,
        method: "GET",
        headers: { Cookie: this.cookie }, // 显式带 Cookie 头
        throw: false,
      });
      const j = qrParseJson(res.text);
      const data = j.data || {};
      const list = data.list || j.list || [];
      if (j.code === 0) {
        this.finish("验证成功：code=0，根目录条目数=" + list.length);
      } else {
        this.finish(
          "验活失败：code=" + j.code + " message=" + (j.message || "") + (j.status ? " status=" + j.status : "")
        );
      }
    } catch (e) {
      this.finish("验活异常：" + (e && e.message ? e.message : String(e)));
    }
  }

  finish(msg) {
    this.stop();
    this.finished = true;
    this.setStatus(msg);
    this.note(msg);
    new Notice("Quark 扫码登录：" + msg, 8000);
  }
}

module.exports = QuarkSetCookieProbe;
