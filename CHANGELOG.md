# CHANGELOG

## Unreleased

+ [修复] 画布视频任务可恢复查询：create 成功后把上游 `videoTask` 写入节点 metadata；超时/刷新中断后错误态优先「继续查询」（只 poll，不重 POST），仍可选手动「重新生成」。Seedance 慢任务不再因客户端超时丢任务 id。
+ [修复] 可灵原生口被拼成 `/v1/kling/...`：`buildApiUrl` 对 `/kling/*` 等主机根路径不再强制 prepend `/v1`（base 已带 `/v1` 时会剥掉），文生 Network 应为 `…/kling/v1/videos/text2video`；此前原生口永远 404/405 只剩统一口回退，请求体 ~177B 的 `POST /v1/video/generations` 在渠道类型为 OpenAI/Sora 时仍会 405。`ai-proxy` 上游拼接同步避免 `/v1/kling`。
+ [修复] 可灵图生/文生仍 405：创建优先 JSON `POST /kling/v1/videos/text2video|image2video`，失败再回退 `/v1/video/generations`；统一口不再把同一张参考图重复塞进 `image`+`images`+`input_reference`（曾导致 ~14MB body）；参考图按中转预算压缩；405 错误文案标明需后台绑定 Kling 渠道类型。`ai-proxy` 白名单补 `/kling/v1/videos/*` 与 `/v1/video/generations/{id}`。
+ [新增] 可灵 / Kling 视频完整适配（openai2api / New API）：模型名含 `kling` 时走 JSON 可灵原生口 + 统一任务口回退，**禁止**落到 OpenAI `/videos` multipart。支持文生与图生（≤2 张：首帧 + 可选尾帧）、时长 5/10s、std/pro（清晰度 high≈pro）、16:9/9:16/1:1；不支持参考视频/音频。工作台/画布预检与设置卡已对齐；轮询复用 OpenAI 兼容路径 `createPath=/video/generations`。不改 Grok/Seedance/Sora/Veo/Agnes。
+ [修复] openai2api/New API Grok 成片下载：创建/轮询仍只走 `/video/generations`（禁止 `/videos` platform 48）；完成态 content 优先 `GET /v1/videos/{id}/content`（New API 成片代理，需 Bearer）。若中转用 `ServerAddress` 拼出丢端口/错主机的绝对 content URL，按渠道 Base 重写后再鉴权下载，修复「需鉴权…Network Error」。创建路径与 content 路径分离；vidgen 公网 CDN 仍不带中转 Key。
+ [修复] 精确短名 `seedance2` / `seedance2.5` 走 OpenAI Video：`POST /v1/videos` + 轮询 `/videos/{id}`，完成无 URL 时可回退 content 下载；纯文生 `model/prompt/seconds(number)/size(像素)`；有参考图/视频/音频时仍完整发送 `content[]` + `metadata.content`（不静默丢素材），并附带 `images`/`videos`/`audios` 兼容字段。其它 `doubao-seedance-*` 仍走 `/video/generations`，Agent Plan 不变；渠道显示名（如「Veo」）不改变上游分组，`under group default` 需中转授权对应分组。`seedance2.5` 按同路径试发，以 Network 真实响应为准。
+ [修复] Seedance 中转时长：OpenAI2API/New API 不接受智能 `-1`，中转只提供固定秒数并把旧 `-1` 归一为 5；时长框可直接输入，滚轮不改值。Agent Plan 仍保留智能时长。
+ [修复] 画布/素材 `POST /api/blobs` 同账号同 `storageKey` 客户端并发合并与会话成功缓存；服务端完整幂等命中不计新上传限额，降低重复同步 429。
+ [修复] Grok 14 模型全模态本地适配：精确区分文本/搜索/生图/图片编辑/视频/TTS/STT/泛语音，避免 `imagine` 子串或 xAI 主机误判模态；codex2api 与 xAI 的精确 `grok-voice-tts` / `grok-voice-stt` 改走原生 `/v1/tts`、`/v1/stt` 协议，其他 OpenAI 兼容渠道仍走 `/audio/speech`、`/audio/transcriptions`。画布音频可转写为 Text 子节点；未知实时 `grok-voice-latest` 不盲试、不冒充 TTS/STT。
+ [修复] 音色选择按当前 TTS 模型所属协议隔离：原生 Grok 只显示 xAI 音色，MiniMax 只显示 MiniMax 音色，OpenAI 兼容渠道与模型脚本只显示 OpenAI 音色；切换模型时自动归一化不兼容的历史音色，并确保界面所选值与实际请求一致。
+ [新增] 3D 导演台自动搭建：描述/参考图规则可离线 + 可选宿主 BYOK 文本/多模态识图；选中角色后自然语言指令调姿；不改生成主路径。

+ [优化] 画布一键排版更美观：层序 barycenter 减交叉、后继按前驱垂直对齐、列居中、列/行间距加大；连线曲率软化封顶（更直、不「甩弯」）。仍可撤销；组/batch 为单元；有选中只排选中。
+ [新增] 多选成组：选中 ≥2 个可成组节点后，多选栏 / 右键「成组」生成贴合框并写入 `groupId`（拖组仍带动成员）；「取消成组」拆框保位置。空组按钮不显示；不改生成/连线语义。
+ [新增] 画布体验切片（借鉴上游 0.15，不整仓 merge）：① 提示词面板「放大编辑」Modal，与浮层共用同一 prompt 状态实时同步，关闭不清草稿；② 底栏 **移动 / 选择** 双模式（默认仍移动=空白拖平移），Space 临时反转，Ctrl/Meta 空白仍可强制框选；③ 元素列表定位缩放上限 **100%**（滚轮仍可放大到 5×）；④ 失败/多图结果：hover 强制显示重试，新增「副本」入口（脱批为独立节点），删除仍维护 batch 主图；⑤ **一键排版**（底栏 / 多选栏 / 右键）— 有选中只排选中，否则全画布；组与 batch 按单元，链路左→右，可撤销。**不改** 生成 API / Grok / Seedance / 云双轨 / 并发生成模型。
+ [修复] Grok 完成态 `video.url` 为相对路径（如 `/v1/videos/{id}/content`，约 55 字符）时：按渠道 Base URL 解析为绝对地址并带 API Key 下载成 blob，不再误报「没有可播放的视频地址」。绝对 CDN URL / 空串晚写 / content 回落路径不变；公网 CDN 仍不带中转 Key。
+ [修复] Seedance 中转 3+ 参考图：全部使用 `reference_image` role，不再把首/末张标成 `first_frame`/`last_frame` 与中间参考混用（上游 `InvalidParameter: last frame image content cannot be mixed with reference image`）。单图 `reference_image`、双图首尾帧不变；不丢图、不退回文生。
+ [修复] Seedance 视频可上云：`api` `from-url` 与前端 `cloud-history` / 落盘 media 代理白名单补齐火山/字节 CDN（`volces` / `volcengine` / `byteimg` 等），与 `ai-proxy/media` 对齐；不再因域名被拦表现为「Seedance 不支持云端」。有 `storageKey` 的本机落盘路径不变；Grok/xAI 路径不变。
+ [部署] 新增 `docker-compose.ic3011.yml`：公司机 `-p ic3011` 时用 `!override` 只绑 `3011:3000`，避免与 `docker-compose.local.yml` 的 3001 端口数组合并抢占同机其它服务。
+ [调整] 新增渠道 / 默认中转站 Base URL 改为 `http://openai2api.com:3000`；未改过的旧默认 `codex2api` / 官方 OpenAI URL 会软迁移到该地址，用户自定义渠道不覆盖。
+ [修复] 画布节点提示词文本框支持滚轮滚动：不再被画布容器的全局 wheel 拦截吃掉；长提示词可在框内滚动查看。
+ [修复] 画布已有内容节点编辑提示词时即时写回 `metadata.prompt`；切换节点或关闭面板不再丢失未点生成的草稿。
+ [修复] openai2api Grok 视频主机适配补全：创建、轮询和完成态内容下载统一由 host profile 决定，只使用 singular `/video/generations` 系列路径；多参考首包使用 New API 明确保留的完整 `images[]`，不再让未知 `reference_images` 被忽略后仍创建无参考任务；用户选择 1080p 时始终先请求 1080p，只有创建失败才降档。
+ [修复] openai2api GPT 生图自动识别为脆弱中转：文生图去掉易被网关拒绝的严格输出字段并保留瘦身重试；多参考编辑旁路每次携带全部 `images[]`，禁止只保留第一张或用纯文生结果冒充多参考成功。

+ [修复] openai2api/New API Seedance 参考媒体完整适配：带媒体请求统一发送带 role 的 `content[]`，并镜像写入 `metadata.content` 供 New API Doubao 适配器展开（图 `image_url`、视频 `video_url`、音频 `audio_url`）；不再混发会让中转只进入首图分支的顶层 `image`/`video`/`audio` 字段；双图使用 `first_frame`/`last_frame`，3+ 图完整保留首尾与中间参考图。前端不再因音频或多视频提前拦截，所有媒体解析失败均在请求前报错且不退回文生。
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
