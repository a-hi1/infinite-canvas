# CLAUDE.md

本文档给后续 Claude / AI 助手快速了解当前仓库使用。开发规范仍以 `AGENTS.md` 为准；本文件主要记录项目上下文、常用工作流、部署状态和当前已知注意事项。

## 项目定位

`infinite-canvas` 是一个面向图片与视觉创作流程的开源 AI 工作台。核心应用是浏览器端 Vite + React 静态前端，提供无限画布、AI 图片/视频/音频生成、提示词库、素材库、画布助手、本地 Canvas Agent 与 Codex 插件集成。

当前项目更适合个人、本地或自部署使用，不是完整 SaaS 平台。默认没有项目自带的业务后端、账号系统或服务端数据库。

## 仓库组成

| 路径 | 说明 |
| --- | --- |
| `web/` | 主 Web 应用，Vite + React + React Router + TypeScript。 |
| `docs/` | 文档站，Next.js + Fumadocs + MDX。 |
| `canvas-agent/` | 本地 Canvas Agent，Node.js + Express + MCP SDK，用于连接浏览器画布与 Codex / Claude Code。 |
| `plugins/infinite-canvas/` | Codex app 插件，封装 MCP 配置和画布操作 Skill。 |
| `Dockerfile`、`nginx.conf` | 主 Web 应用 Docker 构建与 Nginx 静态托管配置。 |
| `docker-compose.local.yml` | 本地源码构建部署用 compose，目前端口映射为 `3001:3000`。 |

## 主应用架构

- 前端：Vite 7、React 19、React Router 7、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query、Axios。
- 路由入口：`web/src/router.tsx`。
- 页面目录：`web/src/pages/`。
- 画布页面：`web/src/pages/canvas/`。
- 画布组件：`web/src/components/canvas/`。
- 画布状态：`web/src/stores/canvas/`。
- 全局配置状态：`web/src/stores/use-config-store.ts`。
- AI API 请求：`web/src/services/api/`。
- 本地图片/文件存储：`web/src/services/image-storage.ts`、`web/src/services/file-storage.ts`。

主应用常规使用时由浏览器前端直接请求用户配置的 AI Base URL。AI API Key、Base URL、画布项目、素材和生成记录默认保存在浏览器本地。

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

## Git / 远程仓库工作流

当前自用部署仓库：

```text
https://github.com/a-hi1/infinite-canvas.git
```

本地开发推荐流程：

```bash
git status
git add <具体文件>
git commit -m "说明"
git push
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

后续计划在 `docs/content/docs/progress/todo.mdx` 中已记录：增加服务端 AI 接口安全代理。目标：

- 前端只请求同源代理接口。
- API Key 存在服务器环境变量或安全配置中。
- 代理只允许必要接口白名单，如 `/v1/images/generations`、`/v1/images/edits`、`/v1/responses`、`/v1/videos`、`/v1/models`。
- 配套访问鉴权、限流和日志脱敏。
- 避免在浏览器 Network 中暴露共享 Key，并缓解 CORS 问题。

不要记录、保存或复述任何用户真实 API Key。若用户在对话中误贴 Key，只提醒其重置，不要写入文件或记忆。

### 图片工作台成功率问题

用户反馈：画布生图成功率高，但图片工作台生图失败率较高。当前高概率原因包括：

- 图片工作台按生成张数并发发起多个 `/v1/images/generations` 请求，容易触发 429 或中转服务限流。
- 图片工作台带参考图时会走 `/v1/images/edits`，部分中转服务未必支持。
- 图片工作台和画布使用的模型、尺寸、质量、数量可能不一致。

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
- 文档正文保持中文，不写过期日期。
