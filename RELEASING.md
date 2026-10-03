# 发版流程（Release process）

> 本文是这个仓库的完整发版说明。README 的「开发」一节只保留一段摘要并链接到这里。
>
> 维护者用；贡献者看 `README.md` 的「开发」一节即可（本仓库还没有 CONTRIBUTING.md）。

## 一句话

**tag 只是候选，2FA 那一下才是发布。** 顺序是：**合并版本 PR → 打 tag → CI staging → 你 2FA 批准 → 转正草稿 Release。**

---

## 标准流程

### 1. 准备版本（走 PR，不能直推）

`main` 有分支保护（require PR + required status checks），**直推会被拒**。所以版本准备是一个 PR：

```sh
git switch -c release/0.2.0          # 从最新 main 开分支
```

- 更新 `CHANGELOG.md` **和** `CHANGELOG.en.md`——两侧是对等正文而不是译文摘要，Release 正文取自两边。
  同时更新 `CHANGELOG.i18n.yaml`：`test/docs.test.ts` 用 blob hash 锁住这一对，改了正文不改记录会红。
- 按 SemVer 提升 `package.json` 的 `version`。
  ⚠️ **tag 与 `package.json` 必须一致**，CI 在 staging 之前就会校验并 `exit 1`。
- `test/release-notes.test.ts` 会断言「`package.json` 声明的版本在两侧 CHANGELOG 里都有对应小节」——
  忘了写 CHANGELOG 段落会在这里就被拦住。

本地先跑一遍闸门（CI 也会跑同样的几道）：

```sh
npm install --cache .npm-cache   # 依赖极少
npm test                         # 先构建，再跑 263 个测试（node --test）
node scripts/check-tarball.mjs   # 发布包既不含本机状态、也不缺该有的文件
```

### 2. 合并 PR

CI（`ubuntu-latest` + `windows-latest` × node 24，外加一个 node 20 的 runtime-floor job）全绿后合并到 `main`。

### 3. 在合并提交上打 tag 并推送

```sh
git switch main && git pull
git tag -a v0.2.0 -m "dsh-jev-tools v0.2.0"
git push origin v0.2.0
```

**推 tag 不受分支保护影响**（ruleset 的 `target` 是 `branch`，`ref_name` 是 `~DEFAULT_BRANCH`），所以这一步永远能走。

### 4. CI 做它该做的（不需要你操作）

`.github/workflows/release.yml` 被 `v*` tag 触发，然后：

1. 校验 tag 与 `package.json` 版本一致——不一致就失败，此时**什么都还没上传**；
2. 跑与 CI 相同的那套闸门（build / test / check-tarball）；
3. 检查这个版本**是否已经有 provenance**；
4. `npm stage publish` —— 经 npm trusted publishing 的 OIDC 身份上传，**不带任何长期 token**。

**此时什么都没公开。** 版本在 registry 的暂存区里：元数据可见，但 tarball 不公开，**谁都装不到**。

### 5. 你用 2FA 批准（这一步只能是人）

```sh
npm stage list dsh-jev-tools
npm stage approve <stage-id>        # 会要 2FA；npmjs.com → Staged Packages 也可以
```

### 6. 把草稿 Release 转正

CI 留下的是**草稿** Release（防止「公告比东西先出现」）：

```sh
gh release edit v0.2.0 --draft=false
```

正文由 `scripts/release-notes.ts` 从两侧 CHANGELOG 生成；缺小节时它**非零退出**，宁可 workflow 变红也不产生空 Release。想先预览：

```sh
node scripts/release-notes.ts 0.1.8
```

这两条命令每次都打印在 run summary 里，不用记。

---

## 为什么分两段

npm 的 trusted publisher 对这个包**只授权 staged publishing**——`npm publish` 不在允许的动作里。

于是：**一个被攻陷的 workflow 没有能力把包直接推给全世界。** tag 表示「这是候选发布」，2FA 那一下才表示「这就是发布」。代价是多一次人工操作，收益是发布路径上永远有一个人的在场证明。

## 为什么动作被钉在 commit SHA 上

所有 `uses:` 都 pin 到完整 commit SHA 而不是浮动的 `vN` tag。原因是 `release` job 持有 `contents: write`：

一个被投毒的 action 本来可以落一个 commit、改掉 `release.yml`，然后由**你自己那条合法流水线** stage 出攻击者构建的包——只剩 2FA 一道闸。pin 住 SHA 之后，上游改 tag 不再影响这里。

[Dependabot](.github/dependabot.yml) 每周为 actions 与 npm 依赖开 PR 来升这些 pin。**pin 要有人升**，所以别关掉它。

---

## 硬性规则

| 规则 | 为什么 |
|---|---|
| **不要为了省事本地 `npm publish`** | 直发的版本没有 provenance，而且**无法补救**——见下节 |
| **先 tag，后其他** | 发布的是 tag 指向的那个提交；先发后补 tag 会让两者错位 |
| **不要在 tag 之后改 `package.json` 版本** | tag 与 manifest 必须一致，否则 CI 在上传前就失败 |
| **不要直推 `main`** | 分支保护会拒；版本准备走 PR |
| **2FA 那一步不要跳** | 它是「这是发布」的唯一表示 |
| **不要只改一侧 CHANGELOG** | `test/docs.test.ts` 的 blob hash 与结构签名会红 |

## 一个版本无法补救的两种情况

这两种情况下**唯一**的修法是**换一个版本号重发**。请把这句话当成本流程里最硬的一条。

1. **本地直发**：`npm publish` 不产生 provenance，而 npm 不允许已发布版本再次 staging。
2. **先发后补 tag**：同上——版本已经在 registry 上，但这条 workflow 从没 stage 过它。

之后每次推这个版本的 tag，release run 都会**变红**，报「public without provenance」。那不是 bug，是闸门在工作。

要让一次**已经发生**的直发不阻塞后续：手动触发 workflow

> Actions → release → Run workflow → 勾选 `acknowledge_unprovenanced`

tag 推送**满足不了**这个输入（`inputs` 在 tag 触发时为空），所以常规发布保持严格。这个开关是给意外准备的，不是常规路径。

> 历史记录：同一天（2026-09-30）`dsh-map-tools@0.7.3` 与 `dsh-jev-tools@0.1.13` 都是本地直发出去的，原因是 github.com 的 git 通道当时连不上、tag 推不出去。两个仓库事后都补了 tag 与 Release。当时 workflow 里那一步是「已发布就跳过 staging」——**它把「在 registry 上」当成了「我们 stage 过」**，于是直发永远不会报警。2026-10-03 换成了 provenance 检查。

## 只读核对：一次发布到底成没成

**判据只有一条：用全新缓存 + `--prefer-online` 把 tarball 真拉下来**，并与本地构建产物对照 sha1。

```sh
npm pack dsh-jev-tools@<version> --cache <新目录> --prefer-online
```

`npmjs.com` 上的 `Published`、`npm view`、完整 packument——**都不算数**：npm 的读路径是几份独立传播的缓存，它们比 tarball 传播得早。

> 本仓库没有本地 publish 脚本（发版完全走 CI）。手动核对用上面的 `npm pack`，或参考 `dsh-map-tools` 的 `scripts/publish.mjs --verify-only` 的写法。

## 出问题时

| 现象 | 原因 / 处理 |
|---|---|
| `tag ... does not match package.json version` | tag 与 manifest 不一致。删 tag 重打：`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` |
| `public without provenance`（红灯） | 这个版本被直发过，无法补救。换版本号重发；或按上文手动触发 |
| `test/docs.test.ts` 报 hash / 结构签名不符 | CHANGELOG 或 README 只改了一侧，或改了没同步 `*.i18n.yaml` |
| `release-notes.ts` 非零退出 | 该版本在 CHANGELOG 里没有小节。补上小节再重跑 |
| staging 成功但装不上 | **正常**——批准之前 tarball 本来就不公开。去批准 |
| 批准后仍拉不到 | 多半是 CDN 传播滞后，等几分钟重试。若 packument 里也看不到版本，才是真失败 |
| Release 是草稿 | 正常。批准之后 `gh release edit vX.Y.Z --draft=false` |
| 2FA 批准失败 | 账号没开 2FA，或 trusted publisher 配置被改过。见 `release.yml` 头部的一次性配置步骤 |

## 与其他文件的关系

- `CHANGELOG.md` / `CHANGELOG.en.md` / `CHANGELOG.i18n.yaml` —— Release 正文的来源，三份必须同步。
- `README.md`「开发」一节 —— 开发流程与发版摘要（指向本文）。
- `docs/dev-workflow.md` —— 本地 bundle 开发/热插拔的实测踩坑记录，与发版无关。
- `docs/s0-trigger-rate.md` —— 默认阈值的实测依据。
