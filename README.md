<p align="center">
  <img src="web/public/logo.svg" width="88" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas)</h1>

<p align="center">
  <b>基于 <a href="https://github.com/basketikun/infinite-canvas">basketikun/infinite-canvas</a>（5.9k★ 开源）的深度二开分支</b>
</p>

<p align="center">
  <a href="https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/github/stars/basketikun/infinite-canvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-f97316?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/over%20upstream-%2B130%20commits-0d9488?style=flat-square" alt="commits">
  <a href="VERSION"><img src="https://img.shields.io/badge/version-v0.2.0-2563eb?style=flat-square" alt="Version"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

> [!IMPORTANT]
> **这是一个二开分支，不是上游本身。**
>
> - 上游：[`basketikun/infinite-canvas`](https://github.com/basketikun/infinite-canvas)（5.9k★），本项目在其基础上自行 clone 后独立维护
> - 遵循上游 **AGPL-3.0**，**保留原作者信息与前端页面标识**
> - 上游仍在活跃演进，本分支维护的是一条**与之长期并存**的改造线，而非一次性复制
> - 仓库总计 291 次提交，其中**相对上游 merge-base（上游 2026-07-05 位置）新增 130+ 次提交**，开发活跃至 2026-08-12

---

## 这个分支改了什么

| 模块 | 上游原状 | 本分支 |
|---|---|---|
| **视频模型** | 以 Seedance 为主 | **Seedance / 可灵(Kling) / Grok 三套原生协议 + 中转协议适配** |
| **可灵 Kling** | — | 原生 `/kling/v1/videos/text2video\|image2video`；文生 / 图生（≤2 张：首帧 + 可选尾帧）、时长 5/10s、std/pro、16:9 / 9:16 / 1:1 |
| **Grok** | — | **14 个模型全模态本地适配**：文本 / 搜索 / 生图 / 图片编辑 / 视频 / TTS / STT / 泛语音 |
| **鉴权与路由** | 单主机 | **openai2api / New API / codex2api / xAI 多主机差异路由**，统一收口在 `video-host-profile` |
| **媒体下载** | 基础链路 | content URL 相对路径解析、按渠道 Base 重写后再鉴权、公网 CDN 不携带中转 Key |
| **画布交互** | 基础拖拽缩放 | **多选成组、一键排版（层序 barycenter）、放大编辑 Modal、移动 / 选择双模式** |
| **其他** | — | 3D 导演台自动搭建、素材墙排序、视频任务可恢复查询（不重新 POST） |

> 说明：「上游原状」以 merge-base 处的上游代码为准；上游后续若有同名功能，属于并行演进，非本分支引入。完整变更见 [CHANGELOG](CHANGELOG.md)。

---

## 三个值得单独讲的改造

### 1. 视频模型的中转协议收口

这是本分支工作量最重、也最难的部分。多家视频模型在**鉴权方式、请求体结构、媒体参考语义、结果下载链路**上全都不一致，踩过的典型坑：

- **同一个字段，语义相反**：`media.role` 在 Seedance 里表示「参考图」，在可灵里表示「首帧」——同一张图传过去，语义完全不同
- **前缀拼错导致原生口全废**：`buildApiUrl` 对 `/kling/*` 强行 prepend `/v1`，原生接口一直 404/405，只剩统一口回退
- **同一张参考图被重复塞进三个字段**：`image` + `images` + `input_reference` 重复填充，请求体一度到 **~14MB**；改为按中转预算压缩参考图
- **下载地址带时效鉴权**：中转拼出的绝对 content URL 丢失端口，按渠道 Base 重写后再鉴权下载，修掉「需鉴权 → Network Error」

处理原则：**把差异全部收口到 host-profile 一层**，上层业务代码切换模型不需要任何改动。

> 设计目标不是「支持更多模型」，而是「**新增一个模型时，只有这一层需要改**」。

### 2. 画布交互与排版

- **多选成组**：选中 ≥2 个节点后成组，写入 `groupId`，拖动组带动全部成员，取消成组自动拆框保位置
- **一键排版**：按节点层级做 barycenter 排序**减少连线交叉**，后序按前驱垂直对齐、列居中、加大行列间距；连线曲率软化封顶
- **移动 / 选择双模式**：默认仍可拖空白平移，`Space` 临时反转，`Ctrl/Meta` + 空白强制框选
- **放大编辑 Modal**：与浮层共用同一 prompt 状态实时同步，关闭不丢草稿

**这几项均借鉴上游思路但未整仓 merge，而是手工挑拣后迁移**——上游对画布层的改动会破坏本分支的协议层改造。

### 3. 与上游长期共存的同步策略

二开真正的难点不是「改」，而是「**改完之后还跟得动上游**」。本分支采用四道闸门：

| 闸门 | 做法 |
|---|---|
| **① 锚点** | 记录 merge-base 的 commit sha 与每次同步时间点，先列出「我改了什么」「上游新增了什么」再动手 |
| **② 分区** | **红区**＝改过的核心文件（协议层 / `ai-proxy` / API 中转层），一个 hunk 都不许直进；**黄区**＝依赖但未改的接口，先跑类型检查；**绿区**＝纯 UI 与文档，整块接受 |
| **③ 验证** | `tsc --noEmit` + 构建 + 关键路径手测（生图 / 生视频 / 任务续跑）。**分叉合并最危险的不是报错，是静默地坏在一条测试走不到的调用链上** |
| **④ 收敛** | 每次同步后把「为什么这样合」写进 CHANGELOG，作为下次锚点；长期目标是把红区持续往配置层收，降低未来同步成本 |

**为什么不用另外三种**：整仓 merge 会把上游对红区的改动强行灌进来；rebase 130 个提交冲突量不可控且会改写历史；直接抄需要的代码能跑，但下次上游再改还得再抄一遍——**这种二开没有可持续性**。

---

## 快速开始

⬇️ 以下为上游原始说明，**clone 地址已替换为本分支**

## 核心功能

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
- AI 创作：浏览器前台直连你配置的 OpenAI 兼容接口，支持文生图、图生图、参考图编辑、文本问答、音频和视频生成；Seedance 2.0 可通过火山方舟 Agent Plan 接入。
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布。
- 本地 Agent：通过本机 Canvas Agent 连接 Codex / Claude Code，让 Agent 通过 MCP 操作当前画布；
- Codex App 插件：提供 Codex app 插件，安装后会自动注册 MCP 并尝试拉起本地 Agent。
- 提示词库：浏览器前端直连多个 GitHub 开源项目，并缓存到 IndexedDB。

完整功能说明见 [功能介绍](docs/content/docs/overview/features.mdx)。

如果你在为担心没有合适的生图API来发愁，可以查看该免费生图项目：[chatgpt2api](https://github.com/basketikun/chatgpt2api)

## 技术栈

- 前端：Vite、React、React Router、TypeScript、Tailwind CSS、Ant Design、Zustand、TanStack Query。
- 前端：提示词库、WebDAV 和 AI 接口都由浏览器前端直连。
- 部署：静态站点托管或 Docker。

## 快速开始

AI API Key、Base URL、画布、素材和生成记录默认保存在浏览器本地。

```bash
git clone https://github.com/a-hi1/infinite-canvas.git
cd infinite-canvas
cd web
bun install
bun run dev
```

Docker 运行：

```bash
docker build -t infinite-canvas .
docker run --rm -p 3000:3000 infinite-canvas
```

运行后默认端口3000，可访问 `http://localhost:3000`。

首次打开后进入右上角配置，填入自己的 OpenAI 兼容 `Base URL` 和 `API Key`。

## New API 自动配置

如果使用 New API，可在 `系统设置 -> 聊天方式 -> 添加聊天设置` 中填入：

```text
https://canvas.best?apiKey={key}&baseUrl={address}
```

跳转后会自动打开配置弹窗并填入 API Key 和 Base URL。
如果自己部署了，可以把 `https://canvas.best` 替换成你部署的地址。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/bj30FtS5/5.png" alt="5" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/hxRvjw51/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/jkWsF8q1/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/XrnfXHx7/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 文档

- [快速开始](docs/content/docs/overview/quick-start.mdx)
- [功能介绍](docs/content/docs/overview/features.mdx)
- [Render 部署](docs/content/docs/overview/render.mdx)
- [Docker 部署](docs/content/docs/overview/docker.mdx)
- [画布节点操作手册](docs/content/docs/canvas/canvas-node-manual.mdx)
- [画布快捷键](docs/content/docs/canvas/canvas-shortcuts.mdx)
- [贡献者协议](CLA.md)
- [漏洞提交](SECURITY.md)
- [待办事项](docs/content/docs/progress/todo.mdx)
- [本地 Canvas Agent](canvas-agent/README.md)
- [Codex app 插件](plugins/infinite-canvas)

## 赞助支持

<div align="center">

如果这个项目对你有帮助，欢迎通过爱发电赞助支持，你的每一份鼓励都是持续更新的动力！

<br>

<a href="https://ifdian.net/a/basketikun">
  <img src="https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%B5%9E%E5%8A%A9%E4%BD%9C%E8%80%85-946ce6?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyMS4zNWwtMS40NS0xLjMyQzUuNCAxNS4zNiAyIDEyLjI4IDIgOC41IDIgNS40MiA0LjQyIDMgNy41IDNjMS43NCAwIDMuNDEuODEgNC41IDIuMDlDMTMuMDkgMy44MSAxNC43NiAzIDE2LjUgMyAxOS41OCAzIDIyIDUuNDIgMjIgOC41YzAgMy43OC0zLjQgNi44Ni04LjU1IDExLjU0TDEyIDIxLjM1eiIvPjwvc3ZnPg==&logoColor=white" alt="爱发电赞助" />
</a>

<br>
<br>

</div>

## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)

点击链接加入群聊【AI开源交流】：https://qm.qq.com/q/DFnKzZ807u

## 开源协议

本项目使用 GNU Affero General Public License v3.0，见 [LICENSE](LICENSE)。

## Star History

<a href="https://www.star-history.com/?repos=basketikun%2Finfinite-canvas&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&legend=top-left" />
 </picture>
</a>