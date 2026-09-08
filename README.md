# Market Data Dashboard

一个本地/服务器可运行的内部市场数据看板。

## 功能

- Position change signal scan
- Small cap monitor
- Rate data
- Market cap display, prioritizing exchange-provided circulating supply when available
- Liquidity, liquidity/market-cap ratio, and 24h flow
- V3 tick liquidity range chart
- 点击表头排序

## 架构约定

项目目前采用轻量单体服务，保持部署简单，但按边界组织代码：

- `server.js`：HTTP 入口、路由编排和业务服务调用；新增 API 先在这里注册，再逐步抽到 `src/`。
- `src/config.js`：端口、外部数据源、缓存、并发和数据文件路径的唯一配置入口。
- `src/json-store.js`：运行时 JSON 状态的统一读写和串行落盘，避免不同功能各自实现文件写入。
- `src/router.js`：API 路由注册、统一异常兜底和静态资源回退。
- `public/`：按功能拆分的页面脚本；`shared.js` 放跨页面格式化和通用渲染逻辑。
- `scripts/`：独立后台任务，例如 Telegram 推送，不在页面里执行定时任务。
- `data/`：运行时状态和历史记录，已被 Git 忽略，不应提交 Token 或用户数据。

新增功能建议遵循：数据源/缓存 -> API -> 页面或后台任务 -> 文档；不要把 Token、服务器地址或运行时 JSON 写进源码。

健康检查会同时返回缓存、持久化加载和后台调度器状态，排查服务器问题时优先查看 `/api/health`。

本地提交前运行：

```bash
npm run check
git diff --check
```

## 本地启动

```bash
npm install
npm start
```

默认地址：

```text
http://localhost:8787/
http://localhost:8787/smallcap.html
http://localhost:8787/reversal.html
```

服务状态检查：

```text
http://localhost:8787/api/health
```

关键区域模块会扫描固定港股、币安美股合约、黄金白银，以及按币安合约 24 小时成交额自动选出的前列交易对，也支持通过页面输入自定义标的。日线只负责生成历史支撑与阻力区域；价格从正确方向重新进入区域时，由 4 小时 K 线触发提醒。连续停留在区域内不会重复计数，已经穿透区域的 K 线不会当成有效触发。

指定端口：

```bash
PORT=8790 npm start
```

Windows PowerShell:

```powershell
$env:PORT=8790
npm start
```

## 服务器部署

服务器需要 Node.js 18+。

```bash
git clone <你的 GitHub 仓库地址> market-dashboard
cd market-dashboard
npm install --omit=dev
PORT=8787 npm start
```

后台运行可用 `pm2`：

```bash
npm install -g pm2
PORT=8787 pm2 start server.js --name market-dashboard
pm2 save
```

访问：

```text
http://服务器IP:8787/
http://服务器IP:8787/smallcap.html
```

## 环境变量

- `PORT`: 服务端口，默认 `8787`
- `REVERSAL_TOP_FUTURES`: 关键区域模块按 24 小时成交额选择的币安合约数量，默认 `40`
- `REVERSAL_MAX_ASSETS`: 关键区域模块单次扫描的标的上限，默认 `80`
- `BSC_RPC`: RPC endpoint，默认 `https://bsc-dataseed.binance.org`
- `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`: 如服务器需要代理访问外部接口，可设置代理
- `CME_FEDWATCH_API_URL`: 可选，覆盖 FedWatch API 地址

## 数据源

- Exchange futures REST API

## 宏观指标 API 配置

美国国债收益率曲线默认读取美国财政部公开的 Daily Treasury Par Yield Curve，不需要 FRED Key。FRED 可作为其他宏观序列的可选数据源；CME FedWatch 仍需要有效 OAuth token：

```powershell
$env:CME_FEDWATCH_OAUTH_TOKEN = "你的 CME FedWatch OAuth token"
npm start
```

未配置 CME 凭据、接口无订阅、超时或返回空结果时，相关项目显示“暂无数据”，不会填充模拟值。
- CoinGecko API
- DexScreener API
- BSC JSON-RPC

## Telegram Push

Create a Telegram bot with BotFather, then get your chat id. Keep both values only on the server.

Use `telegram.env.example` as the template. Copy it to `telegram.env`, fill in the Token and Chat ID, then load it with `set -a; source telegram.env; set +a` before starting the notifier.

Test one push:

```bash
cd /opt/binance-dashboard
export TELEGRAM_BOT_TOKEN='your_bot_token'
export TELEGRAM_CHAT_ID='your_chat_id'
npm run notify:telegram -- --once
```

Run hourly with pm2 (每次同时推送仓位异动和低市值异动):

```bash
cd /opt/binance-dashboard
TELEGRAM_BOT_TOKEN='your_bot_token' \
TELEGRAM_CHAT_ID='your_chat_id' \
pm2 start npm --name market-signal-push -- run notify:telegram
pm2 save
```

Optional overrides:

```bash
SIGNAL_SCAN_URL='http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=30&maxSymbols=500'
SMALLCAP_SCAN_URL='http://127.0.0.1:8787/api/scan?period=4h&points=5&threshold=0&maxSymbols=500&smallCapMaxUsd=100000000&smallCapMinChange=30'
REVERSAL_HISTORY_URL='http://127.0.0.1:8787/api/reversal/history?limit=100'
SIGNAL_INTERVAL_MS=3600000
```
