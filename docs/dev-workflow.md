# DSH 本地 bundle 开发工作流（实测）

> 这些是开发 `dsh-jev-tools` 过程中在**本机 DSH 0.1.6-alpha.2** 上实测得到的规则，不是文档转述。
> 每一条都花过时间，写下来避免重复踩。

## 1. 什么改动需要什么级别的重载

| 改动 | 生效方式 | 原因 |
|---|---|---|
| host 半边 `lib/*.js` **内容** | **必须重启 `dsh web`** | **关开 bundle 无效**——Node ESM 按 URL 缓存模块，重挂同一路径拿到的是旧模块。见下方警告 |
| `package.json` 里新增/修改 **`dsh.client`** | **必须重启宿主** | 见 §2，`client-modules` 按包名缓存扫描结果 |
| `client/*.js` **内容**（manifest 不变） | HMR watch 可接 | `client-modules` 有 `artifactBaseline` / `rebuilt()` 的 fs watch |
| 新增 host 行（patch 里加 row） | `install_bundle`（新 bundle）或重启 | — |

> ⚠️ **这一行曾经写错，代价很大。** 早期的表格写的是「关→开 `set_bundle` 即可」，实测**不成立**：S4–S6 的宿主代码因此一度**从未执行过**——每次看起来都"重载成功"（两次 `applied`、无 warnings），但跑到的是缓存的旧模块。`set_bundle` 会让行卸载重挂，而 ESM 模块注册表按 **URL** 缓存，同一文件路径第二次 import 直接返回旧实例。
>
> **判定方法**：别信 `applied`，去看一个只有新代码才会有的可观测差异（例如 `Tool.listTools` 里新注册的工具）——如果它没出现，就是没生效。

**推论：`dsh.client` 从第一次安装就该声明好。** 后补要被缓存的 `null` 挡住，只能重启。

## 2. 为什么后补 `dsh.client` 必须重启（源码依据）

`packages/client/modules/src/index.ts`：

```ts
private resolveMeta(loaderName: string, baseUrl: string): ResolvedPkgMeta | null {
  const sourceKey = this.sourceKey(loaderName, baseUrl)
  const cached = this.pkgMeta.get(sourceKey)
  if (cached !== undefined) return cached        // ← 命中即返回
  ...
  const decl = parseDshClient(packageName, pkg.dsh?.client)
  if (decl === undefined || decl.platform !== 'web') {
    this.pkgMeta.set(sourceKey, null)            // ← 缓存"不是客户端行"
    return null
  }
  ...
}

private sourceKey(loaderName, baseUrl) { return `${baseUrl}\0${loaderName}` }
```

`sourceKey` 只含 `baseUrl` + 包名，**关开 bundle 不会改变它**。所以包在"还没有 `dsh.client`"时被扫过一次，就会把 `null` 缓存到进程结束——之后无论怎么重挂都不会再被当作客户端行。

文件头也写明了：*"Scanning is incremental per package — there is no full-rescan code path."*

**实测表现**（`Slots.listSubTree { root: 'plugins.bundle.config' }` 的 `occupants`）：

| 状态 | occupants |
|---|---|
| 后补 `dsh.client`、未重启（关开 bundle 也无效） | `[]` |
| **重启宿主 + 刷新页面后** | `[{ registrant: 'lc', key: 'dsh-jev-tools', active: true }]` ✅ |

所以这条结论是**实测确认**的，不只是源码推断。另外客户端 inspect 查询是**由已连接页面回答**的，两层条件都要满足：宿主扫描到 **且** 页面重新拉取过客户端 bundle——只重启不刷新，`occupants` 仍会是空。

## 3. `install_bundle` 不能用于已存在的本地包

对已经以 `link:` 形式装好的包再调一次 `install_bundle`，返回：

```
application: "failed", error: { code: "ambiguous-install" }, changed: false
```

`changed: false` 意味着**什么都没被改动**，bundle 仍在 profile 的 `dependencies` 与 `dsh.profile.bundles` 里。安全的迭代方式是 §1 的关开，而不是重装。

## 4. npm 上的 DSH 包严重滞后

实测（`npm view`）：

| 包 | registry | 本机部署 |
|---|---|---|
| `@deepseek-ai/dsh-settings` | `0.0.1-rc.1` | `0.1.6-alpha.2` |
| `@deepseek-ai/dsh-tools` | `0.0.1-rc.1` | `0.1.6-alpha.2` |
| `@deepseek-ai/dsh-credentials` | `0.0.1-rc.1` | `0.1.6-alpha.2` |
| `@deepseek-ai/schemastery` | `3.18.2` | `3.18.2` ✅ |

**所以不要从这些包 import 类型**——会按陈旧签名编译。本插件改用**结构化类型**（`src/host.ts`），真实契约是服务名字符串。副作用：这也是抗版本漂移的正确姿势，而版本漂移正是社区插件的头号差评来源。

`@deepseek-ai/schemastery` 是唯一版本对得上的，可以正常依赖。

## 5. 客户端槽位：用哪个

| 槽位 | 现状 | 说明 |
|---|---|---|
| `settings.plugin.item` | **不存在** | map-tools 的 `client/client.js` 注册到这里。槽位不存在时 `inject` 不会触发，卡片静默不挂载。**官方对应槽位叫 `plugins.item`**——`ui-settings-plugins/src/client/index.ts` 里 shell / agent-loop / subagent / web-search 四张卡都注册在那里 |
| `plugins.bundle.config` | **可用，本插件用它** | keyed，key = bundle 包名。`ui-plugin-manager` 的 `PluginManagerPage.tsx` 以 `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })` 渲染 |
| `settings.section` | 可用 | 整个独立的设置页（list） |

注册形式已对官方实现核过：`ctx.slots.inject(槽位, () => ctx.slots.register({ name, key }, 组件))`，与 `ui-settings-plugins` 里那四张卡写法一致。
`ui-plugin-manager` 另有一份 config ledger（`config-ledger.ts` 的 `keysOf('plugins.bundle.config')`），用来知道哪些 bundle 自带配置卡片。

## 6. 命令速查

```powershell
# 构建 + 测试（pretest 会自动构建，测试跑的是 lib/ 产物）
npm test

# 重载 host 半边（改 lib/ 之后）
#   plugin_manager set_bundle target=dsh-jev-tools enabled=false
#   plugin_manager set_bundle target=dsh-jev-tools enabled=true

# 验证客户端槽位占用
#   cordis_inspect_query platform=client provider=Slots method=listSubTree
#     input={"root":"plugins.bundle.config"}

# S0 触发率（无需 key、无网络）
node scripts/trigger-rate.ts --json trigger-rate.json
```

## 7. 测试跑的是 `lib/` 而不是 `src/`

`src/` 里的 import 用 `.js` 扩展名（NodeNext 规范，编译产物需要），所以 Node 直接跑 `.ts` 源码时解析不到 `./tokens.js`。测试改为 import `../lib/*.js`，`pretest` 先构建——**顺带验证了真正会发布的那份产物**。

**同一个原因还有两个后果**：

- **脚本不能直接 import `src/` 里的模块**（源码的相对 import 带 `.js`，磁盘上只有 `.ts`，Node 不做扩展名改写）。脚本要么 import `lib/`（需先 build），要么自成一体——`scripts/lib/` 只依赖 `node:` 与 `lib/`。
- **`node --test` 的 strip-only 模式不支持 TS parameter properties**。`constructor (readonly name: string, ...)` 直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；测试是 `.ts` 且不经过 tsc，所以必须显式声明字段再赋值。

## 8. junction / link 安装的包，裸 import 解析不到 profile 的依赖

profile 里的包是以 **junction** 链到开发目录的（`profiles/web/node_modules/dsh-jev-tools → D:\...\dsh-jev-tools`）。但 **Node 的 ESM 会对被导入模块做 realpath**，所以解析裸标识符的起点是**真实路径**，不是 link 路径：

```
import.meta.url → file:///D:/projects/.../dsh-jev-tools/.probe/probe.mjs   ← 已经是真实路径
await import('zod')  →  ERR_MODULE_NOT_FOUND                               ← 在 workspace 树里找不到
```

**实测确认过，不是推断。** 后果：宿主提供的依赖（`zod`、`@deepseek-ai/*`）**不能裸 import**。本插件的应对是全程用**结构化类型 + 服务名字符串**（`src/host.ts`），台账的域 spec 也因此手写了校验器而不用 zod。

## 9. `dsh plugin` 的真实契约

`apps/cli/src/args.ts`：

```
dsh plugin --profile <name> <pnpm 参数…>
```

- `--profile` 是 **`requiredOption`**——所以 `dsh plugin add <pkg>` 是**错的**（缺 `--profile`，Commander 直接拒）
- `--profile` 之后的参数**原样转发给 profile 目录里的 `pnpm`**（`add` / `remove` / `why` / …）
- **它只装包，不启用**。插件页面那条路才是一步装好并启用

## 10. 这台机器上的 shell 不是 UTF-8 安全的，读也不行

PowerShell 按 GBK 解码 UTF-8 文件：控制台输出变乱码，**而且行数会少**——3 字节汉字的第三个字节被当成 GBK 前导字节，把后面的换行吞掉了。

实测：我曾据 PowerShell 得出某文档只有 112 行、疑似损坏的结论，**实际它是 155 行且完好**。

**规则：统计/校验非 ASCII 文件一律用 Node 显式 `utf8` 读，或直接看 `edit` / `read` 工具的结果。改含非 ASCII 的源文件绝不用 `Get-Content` + `Set-Content`（会写成乱码，我因此重写过一次 `prune.ts`）。**

## 11. 双语文档的维护约定

`README.md` + `README.en.md`、`CHANGELOG.md` + `CHANGELOG.en.md`：**每份文档都是三个兄弟文件**——一个不加后缀的 `foo.md`、一个带语言后缀的 `foo.<lang>.md`、外加一个 `foo.i18n.yaml`。两份内容是**对等的两份正文**，不是"原文 + 摘要"。

**一对文档是三个兄弟文件**：默认语言一份 `foo.md`、可切换的一份 `foo.<lang>.md`、外加 `foo.i18n.yaml` 记录两侧在上一次确认一致时的 **git blob 哈希**：

```bash
git hash-object README.md README.en.md
```

**改任一侧，必须同步另一侧并重新记录**，否则 `test/docs.test.ts` 直接红。

**`test/docs.test.ts` 强制七件事**（这是本项目的 CI，没有别的东西在守约定）：

1. 每对文档三个文件齐全，且记录里点名的文件真的存在；
2. 记录的哈希与当前内容一致——**改了任一侧而没重新记录，就是红的**；
3. 每侧都有语言切换行（`[English](foo.en.md)` ↔ `[中文](foo.md)`）；
4. 两侧**结构镜像**：标题层级顺序、列表项数、表格行列数、代码块语言、链接目标；
5. 行内锚点在**该侧自己的标题**里能解析（标题是翻译的，`#v01-boundaries` 与 `#v01-的边界` 是同一个目标，所以第 4 项把锚点归一化掉，再由这一项单独校验）；
6. **配对文档不得链接到被 gitignore 的文件**——那对克隆仓库的人是死链，而本地看起来完全正常；
7. 文档里声明的测试数量与实际测试数一致。

**它守不住的那一半要写清楚：绿灯只意味着"在这份内容上确认过一致"，不意味着两侧说的是同一件事。** 翻译是否忠实、术语是否得当、读起来是否自然，是评审的事，哈希管不了。

**一条由此产生的约定**：文档里可以写测试数量，但只能是**当前版本**的数量——第 7 项会数出 `test/*.test.ts` 里的测试数并核对每一处声明。这个数字在本项目里漂移过四次（136 → 160 → 183 → 189），每次都让文档短暂地撒谎，所以现在它漂不动了。旧版本的 changelog 条目**不要**写测试数，那会变成一句关于当下的陈述。

（DSH 自己用 `pnpm run verify-translation-pairing --write <path>`，那个脚本在 harness checkout 里，独立 bundle 跑不了；`git hash-object` 不需要仓库、算出的 blob 哈希一致，格式兼容。本项目的 blob 哈希由 `test/docs.test.ts` 用 `node:crypto` 直接算，连 git 都不需要。）

## 12. 哪些文件不上传：`notes/` 与本地工作文档

仓库里有两个不同的位置，分界线是"陌生人克隆下来有没有用"：

| 位置 | 上传？ | 放什么 |
|---|---|---|
| `docs/` | **是** | 项目文档：开发踩坑（本文件）、实测依据（`s0-trigger-rate.md`）。它们是别人理解这个项目为什么这么设计所需要的东西 |
| `notes/` | **否**（已 gitignore） | 作者自己的材料：立项计划、草稿、调研、会话笔记。**不被任何已上传的文档引用**——第 6 项检查就是防这个 |

所以：**开发计划之类的放 `notes/`，不要放 `docs/`。** 原始立项文档就在 `notes/dsh-jev-插件开发项目.md`。

`.gitignore` 里写了这条规则和它的理由；第 6 项检查保证"不上传"和"不被引用"这两件事不会各自漂移——一旦某个已上传的文档链接进 `notes/`，测试立刻红。

## 13. Node 的删除在这台机器上会被静默忽略

用 Node 删文件会**不报错、也不生效**：

```js
fs.rmSync('x.md')          // 不抛异常
fs.existsSync('x.md')      // 同一个进程里立刻检查：仍然是 true
```

实测确认过（不是推断），两个进程都看得见这个文件仍然存在。用 PowerShell 的 `Remove-Item` 则**立刻生效且持久**。

所以这台机器上正确的分工是**反直觉的**：

| 操作 | 用 | 不要用 |
|---|---|---|
| 读/改含非 ASCII 的文本 | `edit` / `write` / `read` 工具，或 Node 显式 `utf8`（§10） | PowerShell 的 `Get-Content`/`Set-Content` |
| **删除、移动、重命名文件** | PowerShell（`Remove-Item` / `Move-Item`） | **Node 的 `rmSync`** |

（这条和 §10 正好互补：shell 不能碰文本，Node 不能碰删除。两个都踩过一次才发现。）


