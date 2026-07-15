# CLAUDE.md

本文档给后续 Claude / AI 助手快速了解当前仓库使用。开发规范仍以 `AGENTS.md` 为准；本文件主要记录项目上下文、常用工作流、部署状态和当前已知注意事项。

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

主应用默认仍可由浏览器前端直接请求用户配置的 AI Base URL。AI API Key、Base URL、画布项目、素材和生成记录默认保存在浏览器本地。

可选云端模式（`api` 服务）：用户注册登录后，图片/视频工作台在**本地生成成功之后**异步把结果上传到服务器（`POST /api/jobs/image|video`），文件按用户隔离存储，经 `GET /api/files/:id` 鉴权访问。工作台历史侧栏支持「本机 / 云端」切换查看云端列表（预览/下载/删除）。本机记录带 `cloudSync` 状态（pending/synced/failed/skipped），失败可在本机列表重试上云，且不得把本地生成成功改成失败。上云优先本地 blob/`storageKey`；若结果只是 `imgen.x.ai`/`vidgen.x.ai` 等远程 URL（浏览器 CORS 无法 fetch），走 `POST /api/jobs/{type}/from-url` 由服务端白名单拉取后落盘。上传幂等：同一用户 + 同一 `client_local_id` 重复提交返回已有任务（`deduped: true`），为后续计费防双扣预留。未登录时行为与原先一致；云 API 不可用时不得阻断本地功能。本地开发时 Vite 将 `/api` 代理到 `http://127.0.0.1:8080`。云端配置示例见 `.env.api.example`（邀请码 `API_INVITE_CODE`、Cookie Secure、来源白名单等）。

P0.5 扫尾（运维与体验）：`GET /auth/me` 返回 `usage`（已用字节、任务数）与 `limits`（容量上限），供顶栏账号弹层展示；受保护接口 401 时前端统一清登录态（`infinite-canvas:cloud-unauthorized` 事件），避免连环报错；未登录生成成功轻提示「登录后可跨设备回看」；上云失败若为空间不足则明确提示。备份脚本：`scripts/backup-api-data.sh` / `scripts/backup-api-data.ps1`。更完整说明见 `docs/content/docs/overview/cloud-api.mdx`。公网 HTTPS 必须设 `API_COOKIE_SECURE=true` 并收紧 `API_ALLOWED_ORIGINS`。

自部署公网共享同一个 Key 时，应优先配置同源 `/ai-proxy`：真实上游 Key 放服务器 `.env.proxy`，前端只保存代理访问令牌或留空。

默认渠道预填为中转站 `https://www.codex2api.com`（名称“默认中转站”），API Key 不写死，由用户自行填写；同时仍支持新增自定义渠道和“服务器 AI 代理”渠道。不要把真实中转站 Key 写进源码或默认配置。

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
  - "3001:3000"
```

原因：服务器上已有其他成员服务占用 `3000`，不要抢占该端口。

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

用户反馈：画布生图成功率高，但图片工作台生图失败率较高。当前高概率原因包括：

- 图片工作台按生成张数并发发起多个 `/v1/images/generations` 请求，容易触发 429 或中转服务限流。
- 图片工作台带参考图时会走 `/v1/images/edits`，部分中转服务未必支持。
- 图片工作台和画布使用的模型、尺寸、质量、数量可能不一致。
- 部分渠道返回远程图片 URL，浏览器直连下载会被 CORS 拦截。

建议后续实现：

- 图片工作台生成改为串行或限制并发。
- 在图片工作台显示实际请求模式：模型、接口路径、参考图数量、生成张数。
- 对 429、CORS、连接失败给出更具体的 UI 提示。

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

继续遵循 `AGENTS.md`：

- README 保持简洁。
- 详细功能文档放入 `docs/content/docs/`。
- 后续待办写入 `docs/content/docs/progress/todo.mdx`。
- 已实现但仍需用户确认测试的事项写入 `docs/content/docs/progress/pending-test.mdx`。
- 涉及项目方向、部署、限制、已知问题或长期工作流变化时，同步更新本文件和 `AGENTS.md`，保证新会话能快速接手。
- 文档正文保持中文，不写过期日期。
