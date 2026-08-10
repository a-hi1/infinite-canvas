# CLAUDE.md

本文档给后续 Claude / AI 助手快速了解当前仓库使用。开发规范仍以 `AGENTS.md` 为准；本文件主要记录项目上下文、常用工作流、部署状态和当前已知注意事项。

## 新会话必读（了解项目 / 继续开发）

用户要求「了解项目」「接管上下文」「继续开发」或新对话开局时，**先读并按其中清单执行**：

→ **[docs/content/docs/progress/session-handoff.mdx](docs/content/docs/progress/session-handoff.mdx)**（会话接手）

该文档含：三套部署端口（本机 3011 / 美国 3001 / 公司 `ic3011:3011`）、Git/remote、硬约束、主线摘要、禁止提交清单、中文汇报模板。细节实现与待验项仍以代码 + `pending-test` / `todo` / `upstream-follow` 为准。

**后续开发必须同步更新文档：** 实质改动后按 `session-handoff` 文内「文档同步规则」更新对应 MDX/`CLAUDE.md`/`AGENTS.md`（有变化才改）。部署端口、主线里程碑、硬约束、未推风险变化时**优先改 session-handoff**，再视需要改本文件摘要。

## 项目定位

`infinite-canvas` 是一个面向图片与视觉创作流程的开源 AI 工作台。核心应用是浏览器端 Vite + React 静态前端，提供无限画布、AI 图片/视频/音频生成、提示词库、素材库、画布助手、本地 Canvas Agent 与 Codex 插件集成。

当前项目更适合个人、本地或自部署使用，不是完整 SaaS 平台。**默认仍是本地模式**（无强制登录）；可选启用云端账号，将生成结果历史上云。自部署时还可启用 `ai-proxy` 隐藏共享上游 API Key。

## 仓库组成

| 路径 | 说明 |
| --- | --- |
| `web/` | 主 Web 应用，Vite + React + React Router + TypeScript。 |
| `docs/` | 文档站，Next.js + Fumadocs + MDX。 |
| `canvas-agent/` | 本地 Canvas Agent，Node.js + Express + MCP SDK，用于连接浏览器画布与 Codex / Claude Code。 |
| `plugins/infinite-canvas/` | Codex app 插件，封装 MCP 配置和画布操作 Skill。 |
| `api/` | 可选云端业务 API（注册登录、生成历史上云、鉴权读文件），Node 22，数据默认 `./data/api`。 |
| `Dockerfile`、`nginx.conf` | 主 Web 应用 Docker 构建与 Nginx 静态托管配置，同源转发 `/api/` 与 `/ai-proxy/`。 |
| `docker-compose.local.yml` | 本地源码构建部署用 compose，端口 `3001:3000`，包含 `app`、`api`、`ai-proxy`。 |
| `ai-proxy/` | Node 22 HTTP AI 安全代理，用服务器 `.env.proxy` 注入真实上游 Key。 |
| `web/public/director-desk/` | 3D 导演台构建产物（同域 iframe）；宿主桥见 `web/src/lib/director-desk.ts`。 |

## 主应用架构

- 前端：Vite 7、React 19、React Router 7、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query、Axios。
- 路由入口：`web/src/router.tsx`。
- 页面目录：`web/src/pages/`。
- 画布页面：`web/src/pages/canvas/`。
- 画布组件：`web/src/components/canvas/`。
- 画布状态：`web/src/stores/canvas/`。
- 全局配置状态：`web/src/stores/use-config-store.ts`。
- 可选登录态：`web/src/stores/use-auth-store.ts`；云端 API：`web/src/services/cloud-api.ts`、`web/src/services/cloud-history.ts`。
- AI API 请求：`web/src/services/api/`。
- 本地图片/文件存储：`web/src/services/image-storage.ts`、`web/src/services/file-storage.ts`。

主应用默认仍可由浏览器前端直接请求用户配置的 AI Base URL。AI API Key、Base URL 默认保存在浏览器本地。画布项目、素材和生成记录默认本地优先；登录后可选云同步（云失败不丢本地）。

可选云端模式（`api` 服务）：用户注册登录后，图片/视频工作台在**本地生成成功之后**异步把结果上传到服务器（`POST /api/jobs/image|video`），文件按用户隔离存储，经 `GET /api/files/:id` 鉴权访问。工作台历史侧栏支持「本机 / 云端」切换查看云端列表（预览/下载/删除）。本机记录带 `cloudSync` 状态（pending/synced/failed/skipped），失败可在本机列表重试上云，且不得把本地生成成功改成失败。上云优先本地 blob/`storageKey`；若结果只是 `imgen.x.ai`/`vidgen.x.ai` 等远程 URL（浏览器 CORS 无法 fetch），走 `POST /api/jobs/{type}/from-url` 由服务端白名单拉取后落盘。上传幂等：同一用户 + 同一 `client_local_id` 重复提交返回已有任务（`deduped: true`），为后续计费防双扣预留。未登录时行为与原先一致；云 API 不可用时不得阻断本地功能。本地开发时 Vite 将 `/api` 与 `/ai-proxy` 默认代理到 `http://127.0.0.1:3011`（需先起
`docker compose -f docker-compose.local.yml -f docker-compose.dev-host.yml up -d`）。
`dev-host` 叠加把 app 再映射 `3011`，避开 Windows 上 VS Code「端口转发」抢占的 `127.0.0.1:3001`/`8080`（否则会误打到远端/其它服务，出现上云 `501` 或登录「来源不被允许」）。
不要假设宿主机 `8080` 一定是本项目 api。云端配置示例见 `.env.api.example`。

**浏览器代理 ≠ Docker 出网**：系统/Clash 美国代理只影响浏览器。视频上云若走 `/ai-proxy/media` 或 `api` 的 `from-url`，是容器去拉 `vidgen.x.ai`；容器访问超时时会 502。本机可在根目录 `.env` 设置 `HTTP_PROXY`/`HTTPS_PROXY=http://host.docker.internal:代理端口` 后重建 `api` 与 `ai-proxy`。服务器不要默认照搬本机 789x 代理。

**当前主线（S0/P0.5c 已出门，收费仍后置）：** 本地 BYOK + 云历史双轨与画布/素材同步已人工验收（见 `docs/.../s0-human-checklist.mdx`、`p05c-acceptance.mdx`）+ **个人自用体验优化** + 上游按矩阵切片。S1 图生图边界已合 `main`；视频多参考图首图静默退化已修；ai-proxy 白名单/Vitest lock 等微修暂缓。平台扣积分/支付/画布扣积分**后置**。**3D 导演台**可回退 modal iframe / 新窗口切片：同域 `/director-desk/`，弹层与新窗口共享 `instanceId`；截图经 postMessage + BroadcastChannel 回流资产，画布页可插入节点；不改生成主路径。

**P2.0-A / P2.0-B / P2.0-C：** `GET/PUT/DELETE /api/projects` + `POST /api/blobs` / `GET /api/blobs/by-key/:clientKey` + `GET/PUT /api/assets`（用户级素材 manifest + tombstones）。项目 JSON、画布媒体、素材清单本地优先同步；推送先媒体后清单/JSON；拉取补齐缺失 blob。云失败不丢本地。Postgres / S3 仍未做。

**协作工作空间 MVP：** 独立 `/workspace` 模块 + `/api/workspaces*`（与私有 assets/jobs 分轨）；显式分享我的资产/工作台历史 + 进度板；邀请码加入；成员读全/传己/删己，owner 可删他人/解散。待人工验收，见 `docs/.../pending-test.mdx`。

**P0.5c：** 已通过并出门。清单 `docs/content/docs/progress/p05c-acceptance.mdx`；自动 `scripts/check-cloud-stack.*` + `scripts/smoke-dual-track.*` 与人工 UI/服务器 B2 均已验收。本机上云占本机 `./data/api`，服务器占服务器 `./data/api`。

**上游跟进：** 矩阵见 `docs/content/docs/progress/upstream-follow.mdx`（对照 **v0.10.0**）。**禁止整仓 merge**；推送 `a-hi1`。已移植：透明背景（BYOK）、组节点（最小）、模型调用脚本（旁路 `modelScripts`）、**画布导出当前/选中节点**、**生成后保留节点提示词**、**节点名默认隐藏**、**提示词搜索防抖**。完整可调宽侧栏/侧栏资产 Tab **现阶段明确不做**（素材用独立素材库；若缺找节点再做最小节点列表）。当前优先自用体验小切片；插件系统保持独立工程。`docker-compose` / `nginx` / 端口 `3001`/`3011` 禁止被上游覆盖。

P0.5 扫尾（运维与体验）：`GET /auth/me` 返回 `usage`（已用字节、任务数）与 `limits`（容量上限），供顶栏账号弹层展示；受保护接口 401 时前端统一清登录态（`infinite-canvas:cloud-unauthorized` 事件），避免连环报错；未登录生成成功轻提示「登录后可跨设备回看」；上云失败若为空间不足则明确提示。备份脚本：`scripts/backup-api-data.sh` / `scripts/backup-api-data.ps1`。更完整说明见 `docs/content/docs/overview/cloud-api.mdx`。公网 HTTPS 必须设 `API_COOKIE_SECURE=true` 并收紧 `API_ALLOWED_ORIGINS`（禁止 `*`）。云端错误 envelope 已开始增加稳定 `reason` 字段，后续前端判断应优先依赖 reason，而不是长期靠中文字符串。

**P1.0-A 已落地：** `api` 已把 JSON 数据访问按 `users / sessions / jobs / files` 拆成 repository façade，底层暂不换库、不改接口和存储格式；目的是为后续 Postgres / 账本 / 项目同步铺路，减少再次从 `index.js` 里拆逻辑。

**P1.0-B 已落地：** `api/src/model/cloud-domain.js` 收口 `JOB_TYPE` / `JOB_SOURCE` / `JOB_STATUS` / `SAVE_STATUS` / `FILE_STORAGE_BACKEND` / `USER_STATUS` / `CLOUD_ERROR_REASON`；`httpError` 与路由 catch 保证 envelope 带稳定 `reason`（含 remote-fetch）。前端 `web/src/lib/cloud-domain.ts` 镜像同一套 reason，登录弹窗与图/视频上云容量提示优先 reason。

**P1.0-C 已落地：** 积分账本 `credit_ledger`（append-only）+ 用户 `credit_balance_cents` 缓存；`GET /auth/me` 返回 `credits`；用户 `GET /api/credits/ledger`；管理员手工加额 `POST /api/admin/credits/grant`（`API_ADMIN_TOKEN`）。

**P1.0-D / P1.0-E / P1.0-F / P1.0-G 代码已落地，但产品面后置：** 可选平台图/视频网关与账本代码保留在仓库，**默认全部关闭**。当前自用策略：**平台扣积分与支付一并后置**——未开 `API_PLATFORM_*_ENABLED` 时账号弹层不展示积分余额，工作台不展示平台开关；用户继续 BYOK/本地生成。需要收费时再开 env + 支付。`/health.platform` 与 `check-cloud-stack` 可查看就绪态。平台视频暂无参考素材/Grok/Seedance 服务端路径。

P0.5b 安全/部署加固（为 P1 铺路，不改本地生成主路径）：`from-url` 白名单域名在 DNS 解析后拒绝内网地址、限制重定向跳数、拒绝 URL 内嵌账号；过期/吊销会话定期清理；`docker-compose.local.yml` 透传 Cookie Secure / 邀请码 / 容量等变量（Compose 从仓库根 `.env` 插值，示例见 `.env.api.example`）。同源自部署默认 `API_TRUST_PROXY_SAME_ORIGIN=true`：浏览器 Origin 与 `Host`/`X-Forwarded-Host`+协议一致时放行（解决 `http://公网IP:3001` 登录 403），跨站仍靠显式白名单；可设 `false` 回到仅白名单。Nginx 必须用 `$http_host`（保留端口）并设置 `X-Forwarded-Host`，不要只用 `$host`（会丢 `:3001`/`:3011`，表现为「localhost 能登、127.0.0.1:端口不能登」）。**当前优先真机验收云端出门条件，勿跳过验收直接做计费或画布全量同步。**

自部署公网共享同一个 Key 时，应优先配置同源 `/ai-proxy`：真实上游 Key 放服务器 `.env.proxy`，前端只保存代理访问令牌或留空。

默认渠道预填为中转站 `http://openai2api.com:3000`（名称“默认中转站”），API Key 不写死，由用户自行填写；同时仍支持新增自定义渠道和“服务器 AI 代理”渠道。不要把真实中转站 Key 写进源码或默认配置。

## 常用命令

### Web 本地开发

```bash
cd web
bun install
bun run dev
```

默认端口：`3000`。

### Web 类型检查 / 构建

```bash
cd web
bun run build
```

如果需要单独类型检查，可执行：

```bash
web/node_modules/.bin/tsc -p web/tsconfig.json --noEmit
```

### Docker 本地源码部署

本项目服务器部署使用源码构建版本：

```bash
docker compose -f docker-compose.local.yml up -d --build
```

当前 `docker-compose.local.yml` 使用：

```yaml
ports:
  - "3001:3000"   # app
# api 仅 expose 8080 到 compose 网络，不默认绑定宿主机 8080
```

原因：服务器上已有其他成员服务占用 `3000`，不要抢占该端口；宿主机 `8080` 也可能被占用，api 经 Nginx `/api/` 同源访问即可。

### 服务器更新流程

服务器项目目录约定：

```bash
~/apps/infinite-canvas
```

后续更新：

```bash
cd ~/apps/infinite-canvas
git pull
sudo docker compose -f docker-compose.local.yml up -d --build
```

查看状态：

```bash
sudo docker compose -f docker-compose.local.yml ps
sudo docker compose -f docker-compose.local.yml logs -f
```

当前部署访问端口是 `3001`。如需正式域名访问，建议用服务器现有 Caddy / Nginx 反代到 `127.0.0.1:3001`。

云端 API 数据备份（服务器）：

```bash
cd ~/apps/infinite-canvas
chmod +x scripts/backup-api-data.sh
./scripts/backup-api-data.sh
# 默认写出 backups/api/api-data-时间戳.tar.gz
```

## Git / 远程仓库工作流

当前自用部署 / 推送仓库：

```text
https://github.com/a-hi1/infinite-canvas.git
```

本地 remote 常见配置：

- `a-hi1` → `https://github.com/a-hi1/infinite-canvas.git`（当前自用推送与部署来源）
- `origin` → 可能仍指向上游 `https://github.com/basketikun/infinite-canvas.git`

新会话接手时，先读取最新本地修改和远程信息，不要假设旧记忆正确：

```bash
git remote -v
git status
git log -5 --oneline
```

本地开发推荐流程：

```bash
git status
git add <具体文件>
git commit -m "说明"
git push a-hi1 main
```

服务器部署流程：

```bash
cd ~/apps/infinite-canvas
git pull
sudo docker compose -f docker-compose.local.yml up -d --build
```

不要随便 `git add .`，因为本地可能有不应提交的文件：

- `PROJECT_ANALYSIS.md`
- `PROJECT_ANALYSIS.pdf`
- `PROJECT_ANALYSIS.typ`
- `PROJECT_ANALYSIS_PRETTY.pdf`
- `web/.verification/`
- `web/dist/`
- `.vscode/`

除非用户明确要求，否则这些分析文档、验证产物和构建产物不要提交。

## 当前已做过的重要修复

- 修复提示词封面为空时渲染空 `src` 的浏览器警告。
- 对远程提示词 tags 做去重，避免重复 key，如 `freestylefly`。
- 对模型列表做去重，减少 Select / key 重复问题。
- 修复旧 Canvas Assistant 会话同步导致的 `Maximum update depth exceeded`。
- 增强图片接口网络错误提示，区分无法连接、401/403、404、429 等常见问题。
- 增强视频生成配置诊断，显示当前模型、渠道和接口类型，并提示 Seedance / OpenAI 视频接口差异。
- 修复 HTTP 非安全上下文下点击本地 Agent 面板时报 `crypto.randomUUID is not a function` 的问题：`crypto.randomUUID` 不可用时降级为时间戳 + 随机字符串。
- 将 `docker-compose.local.yml` 宿主机端口改为 `3001`，避免与服务器已有 `3000` 服务冲突。

## 已知问题与后续待办

### AI API Key 安全代理

当前前端直连 AI 服务时，浏览器 Network 能看到 `Authorization: Bearer ...`。这对个人自用尚可，但不适合公网多人共享同一个 Key。

已增加首版 `ai-proxy`：

- Docker 源码部署使用 `docker-compose.local.yml`，包含 `app` 与 `ai-proxy`；主 Nginx 通过 `/ai-proxy/` 同源转发到代理容器。
- 真实上游地址和 Key 写在服务器 `.env.proxy`（参考 `.env.proxy.example`），不要提交真实 `.env.proxy`。
- 前端配置弹窗可点击“添加服务器代理”，Base URL 为 `/ai-proxy`，API Key 填 `AI_PROXY_ACCESS_TOKEN`；如果代理未启用访问令牌，前端允许留空。
- 代理做接口白名单、访问令牌、基础限流和日志脱敏；已覆盖图片、编辑、模型、文本、音频、OpenAI 视频、Seedance/Agent Plan 和 Agnes Video 相关路径。
- `/ai-proxy/media` 可用于转发部分上游临时媒体 URL，避免浏览器 CORS 拦截；当前白名单包含 Agnes 媒体域名，以及 `imgen.x.ai` / `cdn.x.ai`。
- 前端 `uploadImage` / `imageToDataUrl` 在远程 `http(s)` 图片直连失败时，会回退到 `/ai-proxy/media`，用于画布生成结果落盘和参考图复用。

后续仍需完善多用户鉴权、额度控制、分渠道上游配置和更细粒度白名单；公开多人使用前不要只依赖一个共享代理令牌。

不要记录、保存或复述任何用户真实 API Key。若用户在对话中误贴 Key，只提醒其重置，不要写入文件或记忆。

### 远程图片 CORS / 重新生成

部分图片渠道（例如 xAI）返回的是临时远程 URL，而不是 `b64_json`。浏览器会因 CORS 无法直接 `fetch` 该 URL，导致：

- 图片可用 `<img>` 显示，但无法写入本地 IndexedDB。
- 若把该远程图强行当作编辑参考图，再次生成/图生图会失败。

当前处理方式：

1. 优先直连下载；失败后尝试同源 `/ai-proxy/media` 转发。
2. 若下载仍失败，则保留远程 URL，保证首次展示和“按提示词重新生成”可用。
3. 画布再次生成时，只有本地可读图片（`blob:` / `data:` / `image:` storageKey）才会走编辑接口；远程不可读图会自动退回文生图。
4. 显式图生图 / 蒙版编辑若依赖不可读远程图，会给出明确错误，提示重新上传本地图或改用 `b64_json` 渠道。

补充：用户若是前端直连中转站 API Key，不依赖本地 `ai-proxy` 时，应主要依赖上述前端降级，而不是要求本机代理一定能访问 `imgen.x.ai`。

### 图片工作台成功率问题

用户反馈：画布生图成功率高，但图片工作台生图失败率较高。

**已落地（勿再当未做重写）：**

- 多张时优先一次 bulk 请求；不足或失败再串行补齐（`runGenerationSlotsSerial`），降低并发 429。
- 生成区展示请求诊断：模型、接口路径、参考图数、张数。
- 网络错误提示已区分连接失败、401/403、404、429 等。

**仍可能失败的原因（验收/排障优先看这些）：**

- 带参考图走 `/v1/images/edits`，部分中转不支持。
- **Grok 多参考图生图已针对中转做过修复：多图时只发送真正的 multi-image JSON payload（如 `images` / `image_urls`），不再混入会静默退化成“只吃第一张”的单图 fallback。** 若以后再出现“只参考第一张”，优先怀疑当前中转后端并未真正实现多图 edits，而不是先回退前端到单图候选。
- 工作台与画布模型/尺寸/质量不一致。
- 远程图 URL CORS 导致落盘/参考图失败（见上一节）。
- 中转限流或上游错误（bulk 失败后串行仍可能整批失败）。

后续若再优化：优先渠道兼容（edits/脚本）与错误文案，而不是重做串行框架。

## 部署与端口注意事项

- 服务器上已有其他成员服务占用 `3000`，不要停止或删除未知容器。
- 当前 infinite-canvas 使用 `3001:3000`。
- 如需域名，优先反代到 `127.0.0.1:3001`。
- 服务器已有 Caddy 占用 `80/443`，后续配置域名时先确认不要影响其他服务。

## 安全注意事项

- 不要把 API Key 写入源码、文档、Git 提交或日志。
- 不要提交 `.env`、浏览器本地配置、截图中包含 Key 的内容。
- 当前前端直连 AI 接口存在 Key 可见问题，公开多人使用前必须增加后端代理或让每个用户自行配置自己的 Key。
- Canvas Agent 默认应作为用户本机服务使用，不要作为公网服务暴露。

## 文档规范提醒

继续遵循 `AGENTS.md`，并维护会话接手文档：

- **新会话入口：** `docs/content/docs/progress/session-handoff.mdx`（了解项目 / 继续开发时先读）。
- README 保持简洁。
- 详细功能文档放入 `docs/content/docs/`。
- 后续待办写入 `docs/content/docs/progress/todo.mdx`。
- 已实现但仍需用户确认测试的事项写入 `docs/content/docs/progress/pending-test.mdx`。
- 上游切片状态写入 `docs/content/docs/progress/upstream-follow.mdx`。
- 运维最短命令写入 `docs/content/docs/progress/ops-daily.mdx`。
- **实质改动后必须同步文档（有变化才改）：** 部署端口 / remote / 硬约束 / 主线里程碑 / 未推风险 → 优先更新 `session-handoff.mdx`；长期架构摘要 → 本文件；可执行规则 → `AGENTS.md`；产品说明 → 对应 overview。完整对照表见 session-handoff 文内「文档同步规则」。
- 涉及项目方向、部署、限制、已知问题或长期工作流变化时，同步更新本文件、`AGENTS.md` 与 `session-handoff.mdx`，保证新会话能快速接手。
- 文档正文保持中文，不写过期日期。
