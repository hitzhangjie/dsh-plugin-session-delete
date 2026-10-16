# @hitzhangjie/dsh-plugin-session-delete

DeepSeek Harness 只提供「归档」:归档的会话永远留在磁盘上。这个插件补上缺失的那一步——**真正彻底删除一个会话**,入口在侧栏会话行的 `...` 菜单里。

一个 DSH **bundle**(声明了 `dsh.bundle.patch`),所以 `dsh plugin --profile <profile> add <path>` 安装后会被自动选入 profile 层,不需要手写 `cordis.patch.yml` 行。

---

## 功能

- **侧栏会话菜单项**:`sidebar.workspaces.session.menu.item` 槽位里的红色「删除会话…」,和内置的 置顶 / 重命名 / Fork / 归档 用同一套 `MenuItemButton` 呈现。
- **两步确认**:第一次点击把标签变成「确认永久删除「<标题>」?」,5 秒不确认自动复位;第二次点击才真正删除。悬停的提示文字也说明了后果。
- **先停活**:删除前通过归档的 `stopActivity` 瀑布停止运行中的工作(durable archive 集合会挡住这些停止所引发的任何唤醒),再等会话落盘安静后继续。
- **拒绝仍有 fork 子会话的会话**:子会话的 header 里记着父 id,删掉父会话会让这条血缘悬空,所以直接拒绝并把子会话 id 返回给界面。
- **本地零残留**,按顺序清理:
  1. 事件日志目录 `<persistence root>/<projectKey>/<sessionId>/`(先按 header 的 cwd 精确算路径,再扫描 session root 兜底)
  2. 投影缓存 `<home>/storages/session_projcache/sessions/<id>.json`
  3. 会话的 spill 目录 `<tmp>/dsh-spill-*/session-<sha256(id)[:12]>/`
  4. 工作区记账 `Workspace.detachSession(id)`
  5. 归档 / 置顶集合中的该 id
  6. 活的 store 条目(如果 store 暴露了 detach)
- **立即从侧栏消失**:删除成功后宿主发出 `api-session/removed`,同时浏览器半区调用客户端 `sessions.refresh()` 重新拉取权威列表——冷会话(本次进程没打开过)不会发出任何 disposal 帧,只有重新拉取才能让它的行消失。
- **写者占用时不留半成品**:文件仍被活的写句柄占住时,id 会记入 `<home>/plugins/session-delete.pending.json`,下次启动(此时所有会话都是冷的)自动补删。

## 安装

```powershell
# 1) 检出
git clone https://github.com/hitzhangjie/dsh-plugin-session-delete.git

# 2) 装进你使用的 profile(桌面版 Harness 固定使用保留 profile desktop)
dsh plugin --profile desktop add "file:<仓库所在路径>/dsh-plugin-session-delete"
```

`dsh plugin` 用的是桌面安装自带的那套运行时,它有权管理 `desktop` profile;npm 全局安装的 CLI 会拒绝针对 desktop 的启动与管理请求。

然后完全退出并重启 Harness。Bundle 的 patch 会把行插进 profile 树:

```yaml
- insert:
    - id: hitzhangjie-session-delete
      name: '@hitzhangjie/dsh-plugin-session-delete'
```

> 行名必须是**裸包名**:`dsh-client-modules` 只把包的浏览器半区挂到「模块说明符正好是裸包名」的 Loader 行上,而 profile 解析层负责把裸包名解析到 profile 自己的 `node_modules`。写成相对路径(`./lib/index.js`)只会加载宿主半区,菜单项不会出现。

## 架构

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `lib/index.js` | 注册 loopback 精确路由 `POST /api/hitzhangjie/session-delete`,校验请求来源后执行整套删除。profile 插件没有 `harness.handle` / `host.call` 通道,所以浏览器半区用同源 `fetch` 调这个路由。 |
| Client | `lib/client.js` | 通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂(bundle id 必须等于包名),往 `sidebar.workspaces.session.menu.item` 注册菜单项,渲染两步确认,调用宿主路由并刷新会话列表。 |

**请求防护**:精确路由在 `webServer.match()` 里优先于应用自己的 `/api` 前缀路由,因此这个 handler 自带守门——`Sec-Fetch-Site` 为 `cross-site` / `same-site` 一律拒绝;带 `Origin` 时必须是 loopback 主机且端口等于本进程 `webServer.port`;没有 `Origin` 与 `Sec-Fetch-Site` 的本机进程被接受(web server 只监听 loopback)。会话 id 另有一层严格字符白名单。

**删除失败而非静默**:`not-found`(会话不存在)、`has-children`(有子会话)、`list-failed`(读不到会话列表,失败关闭而不是假定没有子会话)、`invalid-id`、`forbidden` 都会以 409/403 返回结构化原因,界面直接显示。

## 开发

```powershell
# 宿主半区冒烟测试:stub ctx + 临时 DSH_HOME,不碰真实会话
node test/host-smoke.mjs
```

- 宿主半区改动需要重启 Harness;浏览器半区改动 `dsh-client-modules` 按文件修订号重新服务,刷新页面即可。
- 浏览器半区是纯 JavaScript(无 JSX),只能 `require` 平台基线模块:`react`、`@deepseek-ai/dsh-client-ui-primitives`(Module Loader 包的隐式 external)。

## 已知边界

- 已经上报的遥测无法撤回,本插件只清理本地状态。
- 别的会话正文里提到该会话的文字属于别的会话,不动。
- 删掉父会话被拒绝,所以子会话 header 里的 `parentSession` 不会悬空;反过来,子会话被删掉后,父会话的分支记录仍保留。
- 正好处于「活的写句柄仍占文件」的极端时序下会走 `deferred` 路径:文件在下次启动时补删。
- 投影缓存路径假定默认 storage 根(`<home>/storages`);profile 把 storage 根搬到别处时,这一个缓存文件会留下(会话已经没了,没有读者)。

---

# @hitzhangjie/dsh-plugin-session-delete (English)

DeepSeek Harness ships archive only: an archived session stays on disk forever. This plugin adds the missing operation — a real, irreversible **session delete** — behind one entry in the sidebar session-row `...` menu.

It is a DSH **bundle** (it declares `dsh.bundle.patch`), so installing it with `dsh plugin --profile <profile> add <path>` selects it as a profile layer automatically; no hand-written `cordis.patch.yml` row is needed.

**Features.** A red `Delete session…` row registered into `sidebar.workspaces.session.menu.item` with the same `MenuItemButton` presentation the built-in actions use; a two-step inline confirmation that disarms itself after five seconds; running work stopped first through the archive `stopActivity` waterfall; sessions with forked children refused (their child headers name the parent); and local state removed with no residue — event-log directory, projection-cache entry, spill directories, workspace accounting, archive/pin membership, and the live store entry when the store exposes one. A file still held by a live writer is journaled to `<home>/plugins/session-delete.pending.json` and reaped on the next start.

**Install, restart, done.** The row name must be the bare package name: `dsh-client-modules` attaches a package's browser half only to the Loader row whose specifier is exactly the bare package name, and profile resolution maps that name into the profile's own `node_modules`.

**Guards.** The exact route wins over the app's `/api` prefix route, so it guards itself: `cross-site` / `same-site` `Sec-Fetch-Site` is refused, a present `Origin` must be loopback on this process's `webServer.port`, and session ids must match a strict character whitelist. Refusals come back as structured JSON (`not-found`, `has-children`, `list-failed`, `invalid-id`, `forbidden`) and are shown in the menu.

**Verify without a harness**: `node test/host-smoke.mjs` runs the host half against a stub context and a temporary `DSH_HOME`.

## License

MIT
