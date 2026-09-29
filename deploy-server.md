# Matrix 服务器部署

运行目录：`/opt/binance-dashboard`

GitHub：`https://github.com/sellzzz/matrix.git`

分支：`master`

不要把服务器密码、GitHub Token 或 `telegram.env` 提交到仓库。

## 首次部署

```bash
cd /opt
git clone https://github.com/sellzzz/matrix.git binance-dashboard
cd /opt/binance-dashboard
npm install --omit=dev
```

启动三个独立进程：

```bash
PORT=8787 pm2 start server.js --name binance-dashboard
pm2 start npm --name key-zone-realtime -- run monitor:realtime
pm2 start npm --name market-signal-push -- run notify:telegram
pm2 save
```

不要再启动 `market-dashboard`。它和 `binance-dashboard` 使用同一个端口，会产生 `EADDRINUSE`。

## 更新服务器

```bash
cd /opt/binance-dashboard
git pull origin master
npm install --omit=dev
git rev-parse --short HEAD
pm2 restart binance-dashboard --update-env
pm2 restart key-zone-realtime --update-env
pm2 restart market-signal-push --update-env
pm2 save
```

## 验证

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s "http://127.0.0.1:8787/api/reversal/realtime?limit=1"
pm2 status
```

健康检查中的 `application.version` 应与当前发布版本一致；实时接口应返回 `schemaVersion: 2`、`policy`、`summary` 和 `connected: true`。

日志中旧的错误不会自动消失。只看重启后的新日志：

```bash
pm2 flush
pm2 logs binance-dashboard --lines 30
pm2 logs key-zone-realtime --lines 30
```

## Telegram 配置

`telegram.env` 只保存在服务器，不提交 Git。更新代码不会删除它：

```bash
cd /opt/binance-dashboard
set -a
source ./telegram.env
set +a
pm2 restart market-signal-push --update-env
pm2 save
```

每日标的总结默认在北京时间 09:00 推送。可在 `telegram.env` 设置 `DAILY_KEY_ZONE_REPORT_HOUR=9`，或随时手动推送一次：

```bash
set -a
source ./telegram.env
set +a
npm run notify:telegram -- --daily-summary
```

推荐同时设置 `TELEGRAM_QUIET_MODE=1`。安静模式不降低扫描频率、不丢弃服务器记录，也不会取消每小时汇报，只合并自动附件并减少低优先级实时阶段的 Telegram 消息。
