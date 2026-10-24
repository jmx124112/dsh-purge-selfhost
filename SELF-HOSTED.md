# 本地自持说明

本插件是本地自持版本：源码就是这个目录，通过 pnpm workspace 软链进 profile
（`node_modules/dsh-purge -> ../local-pkgs/dsh-purge`），远端仓库不参与安装与更新。

## 当前版本

- `package.json` 的 version：`1.1.22`
- 更新通道由 `lib/update.js` 的 `SELF_HOSTED` 关闭；`REPO` 指向本仓库

## 已内联的本地定制

这些改动直接写在源码里，不再靠 pnpm patch：

- `lib/index.js`：面板所有路由先过宿主的 `connection.requestRejection()` 签名校验，
  没带 Origin 的裸客户端访问 `/dsh-purge/*` 会拿到 401
- `lib/core.js`：去掉对 liangshen 插件的运行时改写（`silenceLiangshenCustomBashFlash` /
  `silenceLiangshenPhase1Strip`）
- `client.js`：去掉 rules / skills 相关 UI 与接口调用
- `lib/update.js`：`SELF_HOSTED` 短路所有远端通道（`listRemoteVersions` / `checkUpdate` /
  `applyUpdate` / `handleUpdateOp` / `autoUpdateIfNeeded`）

## 改完之后

源码改动即时反映在文件系统，但宿主进程里是已加载的旧模块，必须重启：

```bash
systemctl --user restart deepseek-harness-web.service
```

重启后自检：

```bash
cd ~/.dsh/profiles/web
export PATH="$HOME/.local/bin:$PATH"
node -e "import('./local-pkgs/dsh-purge/lib/index.js').then(m=>console.log(Object.keys(m)))"
node -e "import('./local-pkgs/dsh-purge/lib/update.js').then(u=>u.checkUpdate()).then(r=>console.log(r.selfHosted, r.hasUpdate, r.localVersion))"
dsh --profile web --dump-config | grep -n dsh-purge
```

## 发版

仓库本身就是更新源。改完代码，bump `package.json` 的 version，写清提交说明，`git push`。
`SELF_HOSTED` 为 `true` 时面板里的「检测更新」只返回本地状态，不会去拉任何远端内容；
把开关改成 `false` 才会走 `REPO` 指向的仓库。

## 注意

- `node_modules/dsh-purge` 是符号链接，改本目录即改运行代码，不需要重新安装
- 不要再给 `dsh-purge` 加 pnpm patch，改动直接进源码
- 不要对 `dsh-purge` 执行 `pnpm add dsh-purge@<ver>`，那会覆盖 `workspace:*` 声明
