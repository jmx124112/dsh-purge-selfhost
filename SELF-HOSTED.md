# dsh-purge 本地自持说明（已脱离上游）

2026-10-24 起，本插件不再由上游仓库安装或更新。源码就是这个目录，
通过 pnpm workspace 软链进 profile：`node_modules/dsh-purge -> ../local-pkgs/dsh-purge`。

## 基线

- 上游：`github.com/YuJunZhiXue/dsh-purge`，commit `58c950ae65a6c4e61688b774146aebce0dcd0647`，version `1.1.22`
- 基线里已包含旧流程 `patches/dsh-purge@1.1.22.patch` 的全部内容（该补丁不再参与安装）：
  - `lib/index.js`：面板路由走 `connection.requestRejection()` 签名校验（裸 curl 访问 `/dsh-purge/*` 返回 401）
  - `lib/core.js`：剥掉上游对 liangshen 插件的改写（`silenceLiangshenCustomBashFlash` / `silenceLiangshenPhase1Strip`）
  - `client.js`：摘掉 rules / skills 相关 UI 与接口调用

## 本次脱离上游的改动（仅 `lib/update.js`）

- 新增模块级开关 `SELF_HOSTED = true` 与提示文案 `SELF_HOSTED_NOTE`
- `listRemoteVersions()`：直接返回空版本表，不发任何请求
- `checkUpdate()`：返回 `selfHosted: true / hasUpdate: false / via: "self-hosted"` 的本地状态（1ms，无网络）
- `applyUpdate()` / `handleUpdateOp()`：更新、切版本、回滚操作一律返回 `ok:false` + 中文提示，不再覆盖本地源码
- `autoUpdateIfNeeded()`：短路为 `skipped: "self-hosted"`

远端地址（`api.github.com` / `raw.githubusercontent.com` / `cdn.jsdelivr.net` / GitHub archive）
的代码仍在文件里，但已全部走不到；保留是为了将来需要时把 `SELF_HOSTED` 改回 `false` 即可恢复。

## 升级到上游新版（手动，别用 UI 的「检测更新」）

1. 取新版源码到临时目录（例如 `git clone` 或下载 tag 压缩包），**不要直接覆盖本目录**
2. 对比新版 `lib/index.js`、`lib/core.js`、`client.js`，把上面三处本地定制重新应用一遍
3. 把新版 `lib/update.js` 的 `SELF_HOSTED` 短路块重新补上（搜 `SELF_HOSTED` 即可定位，共 5 处）
4. 覆盖本目录内容后自检：

```bash
cd ~/.dsh/profiles/web
export PATH="$HOME/.local/bin:$PATH"
node -e "import('./local-pkgs/dsh-purge/lib/index.js').then(m=>console.log(Object.keys(m)))"
node -e "import('./local-pkgs/dsh-purge/lib/update.js').then(u=>u.checkUpdate()).then(r=>console.log(r.selfHosted, r.hasUpdate, r.localVersion))"
dsh --profile web --dump-config | grep -n dsh-purge
```

5. 重启宿主：`systemctl --user restart deepseek-harness-web.service`

## 注意

- 本目录是 pnpm workspace 包，`node_modules/dsh-purge` 是**符号链接**，改本目录即改运行代码（无需重新安装）
- profile 的 `pnpm-workspace.yaml` 已移除 `patchedDependencies`；不要再给 `dsh-purge` 加 pnpm patch，改动直接进源码
- 旧补丁留在 `~/.dsh/profiles/web/patches/`，仅作历史对照
- 若在 Web「插件」页对其他插件点安装/更新，dsh 会对该插件跑 pnpm；不要对 `dsh-purge` 本身执行 `pnpm add dsh-purge@<ver>`，那会覆盖 `workspace:*` 声明
