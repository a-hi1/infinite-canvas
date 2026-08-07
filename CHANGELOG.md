# CHANGELOG

## Unreleased

+ [修复] openai2api/New API Seedance 参考媒体完整适配：带媒体请求统一发送带 role 的 `content[]`（图 `image_url`、视频 `video_url`、音频 `audio_url`），不再混发会让中转只进入首图分支的顶层 `image`/`video`/`audio` 字段；双图使用 `first_frame`/`last_frame`，3+ 图完整保留首尾与中间参考图。前端不再因音频或多视频提前拦截，所有媒体解析失败均在请求前报错且不退回文生。
+ [修复] openai2api Grok 不再试 `POST /v1/videos/generations`（用户实测 `Invalid URL` 404）；主机 profile 仅保留 `/video/generations`。Seedance 中转 body 补 `durationSeconds` 对齐可用脚本字段；`duration` 仍为数字、`seconds` 仍为字符串。
+ [优化] 视频中转**主机级自动适配**（`web/src/lib/video-host-profile.ts`）：`openai2api` / `codex2api` / xAI / 内网 New API / lan-ai 的 Grok 创建路径、是否允许 `/videos` 兜底、Seedance 中转路径、多图压图规则收口到一处；扩展新主机优先改 profile，避免每次散改 `video.ts`。openai2api 上 Grok 多图按中转压 data URI 并发完整 `reference_images`。
+ [优化] openai2api 上 Grok 若 Network 已是 `/video/generations` 仍 `invalid api platform: 48`：错误文案明确为 New API「模型所属渠道类型」未绑 xAI/Grok（不是 body 字段问题）；工作台引导条在该主机显示主机自动适配 + 渠道类型说明；Seedance 仍可用本站。
+ [修复] openai2api Grok `invalid api platform: 48`：公网 `openai2api.com` 按 New API 处理，Grok 只打 `/v1/video/generations`（可再试 `/videos/generations`），**禁止**落到 OpenAI Sora 适配器 `/v1/videos`；内网 New API 同步去掉 Grok 的 `/videos` 兜底；错误文案标明已尝试路径。
+ [修复] openai2api Seedance 对齐同事 Comfy 成功形态：`duration` 数字 + `seconds` 字符串；单图 `images[]`/`image`；双图顶层 `first_frame`+`last_frame`；3+ 图 `image`+`reference_images`（禁止无 role 多图 `images[]`）；参考视频顶层 `video`（可选 `image`）；中转参考视频限 1 条。
+ [优化] openai2api Seedance 正常使用：工作台区分「OpenAI 中转 / Agent Plan」引导；2 张首/尾帧、3+ 主参考/补充角标；中转参考音频与自定义脚本拦截前置。
+ [修复] 原生 Seedance 中转多图/参考视频（历史探测）：曾用 content role；现以 Comfy 顶层字段为准，见上条。
+ [修复] 原生 Seedance 中转多图贴合度：content 形态对齐 Agent Plan（`role` 只写在 content item，不再塞进 `image_url`）；多图取消 1024/280KB 强压，默认保留原图 data URI（仅 >2.5MB 才软压）。
+ [修复] 原生 Seedance 中转多图：撤回与 `content[]` 双发顶层 `images[]`（中转会把无 role 的 images 再展开成 content，触发 `role must be specified`）；多图仅 `prompt` + 带 role 的 `content[]`；单图 `images[]`/文生不变。
+ [优化] Grok 多图参考生视频失败文案：识别 `xAI upstream returned status 404`，明确是中转/上游 multi-reference 能力问题，不是前端未发多图或路径写错；引导先验证单图/文生，多图可改 Seedance。
+ [修复] 原生 Seedance 中转多图/参考视频：`content[]`+role 同时保留顶层 `prompt`，避免中转 `prompt is required`；单图 `images[]` / 文生不变。
+ [修复] Seedance 参考视频本地校验：去掉误用输出档像素总量（640×640～2206×946）拦截；保留 300–6000px 边长、0.4–2.5 宽高比、2–15s/总 15s、50MB；常见 720×480 / 1080p / 4K 可上传。
+ [修复] 原生 Seedance 中转多参考：上游报 `role must be specified for image contents` 时，多图/参考视频改走 `content[]`（`first_frame`/`last_frame`/`reference_image`/`reference_video`）；单图仍用已验证的 `images[]`；文生不变；禁止静默丢素材。
+ [修复] 原生 OpenAI2API/New API Seedance 中转支持参考视频：多参考走 `content[].video_url`；参考音频仍需火山 Agent Plan。
+ [修复] 原生 OpenAI2API/New API Seedance 中转支持图生视频：单图 `images[]`；多图 `content[]`+role；禁止静默丢图或退回无图。
+ [修复] 原生 API Key 使用 OpenAI2API/New API 的 `seedance2` 时，改走 `/v1/video/generations` 并发送数字 `duration`；火山 Agent Plan 仍保留 `/contents/generations/tasks` 与参考素材能力。
+ [修复] 视频模型调用脚本的 `params.seconds` 改为 number，避免 Seedance `/v1/video/generations` 因 `duration: "4"` 返回 `invalid request body`。
+ [修复] 图/视频工作台多任务并发生成时，历史卡片「生成中」时长按 `createdAt` 实时计时，不再卡在 0 秒。
+ [新增] 工作空间素材墙/生成分享：按批次文件夹（含未归入）独立拖拽排序；`folder_sort_order` + `PUT .../items/reorder`；「全部」视图只读不拖。
+ [修复] Grok 完成态 `video.url` 晚写/空串：优先读官方 `video.url`，完成无地址等待约 3 分钟并补 content 回退；错误文案标明 url 形态。
+ [优化] 视频结果真实清晰度标注：实测低于所选时显示「实 720p · 选 1080p」，不虚标所选档位。
+ [新增] 图/视频工作台提示词支持 `@` 选择已添加参考素材（缩略图 chip，序列化为图片N/视频N/音频N）；不改生成 payload 与 Grok 多参考。
+ [新增] 画布九宫格/角色表轻量切片：AI 优化 `character_sheet` intent + 切图 3×3 预设 + 子节点 `sheetCell`/`sourceSheetNodeId`。
+ [优化] 版本更新弹窗：默认展示本机 CHANGELOG；上游 basketikun 日志折叠可展开对照，不再打开时整表覆盖本机条目。
+ [新增] 协作工作空间 MVP：素材墙/生成分享/进度板/文档素材/分类墙/终稿/决议/邀请码；文件夹 `folder` 与分类正交 + 墙面 UI 分层去杂乱。
+ [新增] 工作台并发生成与按任务停止（AbortController）；画布并发生成（runningNodeIds + runId）。
+ [新增] 我的资产分类管理、智能归类、提示词摘要标题与详情生成提示词。
+ [新增] Grok / Sora / Veo / Seedance / Agnes 渠道兼容与多参考约束（禁止静默只发第一张等）。
+ [新增] 可选云端账号与生成历史上云、画布/素材本地优先云同步（P2.0-A/B/C）、`ai-proxy`。
+ [新增] 可选模型调用脚本：按 `渠道::模型` 本地配置；空脚本走系统默认。
+ [新增] 画布顶栏导出：导出当前画布 zip、导出选中节点 zip。
+ [新增] 画布组节点：可创建组、拖入节点分组、拖动组带动子节点。
+ [新增] 图像设置「透明背景」开关（BYOK）。
+ [修复] 画布透明背景开关可稳定开/关；节点 AI 配置合并收口。
+ [修复] 画布云同步 tombstone，避免删除项目同步复活。
+ [修复] contentEditable 提示词 IME 输入时占位灰字挡字。
+ [调整] 平台扣积分/支付产品面后置；默认 BYOK。
+ [调整] 登录账号弹层始终展示云端积分余额；平台代生成是否就绪仅改文案。
+ [调整] Docker 改为 nginx 静态托管；前端 Vite 构建；本机可映射 3001/3011。
+ [新增] Codex App 插件支持。
+ [新增] 上游跟进矩阵与双轨冒烟脚本；清单实现核验文档。

## v0.5.0 - 2026-07-05

+ [新增] 渠道兼容Gemini格式。
+ [调整] 前端从 Next.js 迁移到 Vite，项目改为静态前端构建。
+ [调整] 移除已 404 的 EvoLinkAI 提示词来源。

## v0.4.0 - 2026-06-16

+ [新增] 新增网页版Agent Loop模式。
+ [新增] 支持Vercel一键部署。
+ [调整] 移除后端，项目定位为个人画布工具。

## v0.3.0 - 2026-06-15

+ [新增] 新增canvas-agent通过codex操作画布。

## v0.2.5 - 2026-06-08

+ [新增] 新增图片切图功能。
+ [新增] 支持webdav同步数据。
+ [修复] 修复画布文字节点错误问题。

## v0.2.4 - 2026-06-04

+ [新增] 新增图片反推提示词功能。

## v0.2.3 - 2026-06-04

+ [新增] 新增图片蒙版局部修改功能。
+ [优化] 优化配置节点@图片功能。

## v0.2.2 - 2026-06-04

+ [新增] 新增图片放大工具。
+ [优化] 优化图片工具条，增加自定义功能。
+ [修复] 修复端口冲突问题、pg/mysql未初始化问题。

## v0.2.1 - 2026-06-03

+ [新增] 新增文档站点页面。
+ [优化] 优化画布连线交互。
+ [优化] 优化模型选择用户偏好。

## v0.2.0 - 2026-06-01

+ [新增] 支持通过火山方舟AgentPlan接入。
+ [新增] 视频生成支持声音、水印及图片/视频/音频参考输入。
+ [新增] 画布新增音频节点。
+ [优化] 图片/视频素材支持 `图片1`编号注入提示词。

## v0.1.1 - 2026-05-30

+ [新增] 支持New API跳转并自动填入Base URL和API Key配置。

## v0.1.0 - 2026-05-26

+ [优化] 优化我的画布、我的素材导出功能
+ [修复] 修复画布撤销，配置节点等bug问题

## v0.0.9 - 2026-05-26

+ [新增] 新增视频创作台页面。
+ [修复] 修复图片节点size参数传递问题。

## v0.0.8 - 2026-05-24

+ [新增] 新增用户账号与算力点体系，支持账号密码注册登录、Linux.do OAuth。
+ [新增] 管理后台公开配置支持设置模型算力点、支持计费查询。
+ [新增] 画布右上角展示用户算力点余额，生成按钮会展示本次预计消耗算力点。
+ [新增] 新增视频生成节点。

## v0.0.7 - 2026-05-23

+ [新增] 管理后台提示词管理支持多选批量删除。
+ [新增] 新增定义拉取GitHub提示词源功能。
+ [新增] 新增awesome-gpt-image2-prompts提示词来源。
+ [优化] 优化模型下拉选择样式、优化生图编辑设置

## v0.0.6 - 2026-05-22

+ [新增] 管理后台支持配置模型渠道，前端当前无需鉴权即可直接使用后端渠道能力。
+ [优化] 统一整理后端错误提示、AI 代理、图片节点生成与重试、参考图缺失处理等细节。
+ [优化] 后端模型代理路径调整为 OpenAI 风格。

## v0.0.5 - 2026-05-20

+ [新增] 右上角版本号支持点击查看版本更新弹窗，展示当前版本、最新版本和按时间线整理的更新日志。
+ [新增] 设置弹窗支持配置系统提示词，AI 生图、编辑图和文本请求会自动携带。

## v0.0.4 - 2026-05-20

+ [调整] Docker 运行入口改为 Next.js 对外提供页面，`/api/*` 由 Next.js 代理到内部 Go 服务。
+ [修复] 文本复制在局域网 IP 访问时可能失败的问题。

## v0.0.3 - 2026-05-19

+ [修复] 更新 nanoid 依赖并修改 ID 生成方式，防止其他ip无法使用crypto模块导致的ID生成失败问题。

## v0.0.2 - 2026-05-19

+ [新增] 初始版本记录与基础画布能力。
