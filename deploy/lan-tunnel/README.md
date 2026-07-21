# 方案 B：家里 Grok2API → 公网 infinite-canvas（FRP 隧道）

让 **公网** `http://你的服务器:3001` 通过同源 `/lan-ai` 使用 **家里** `192.168.6.78:8000` 的 Grok2API。

## 原则（不影响其他）

| 项 | 说明 |
| --- | --- |
| 独立 compose | `docker-compose.frps.yml` / `frpc.yml` **不**并入主 `docker-compose.local.yml` |
| 默认不启动 | 不执行 frp 命令则与原来完全一样 |
| 端口 | 主站仍 `3001`；仅可选增加公网 `7000`（frp 控制）+ 本机 `127.0.0.1:18000`（隧道出口） |
| 安全 | `18000` 只绑 `127.0.0.1`，外网不能直连家里 API；前端仍走 `/lan-ai` + API Key |

```text
浏览器 → http://公网IP:3001/lan-ai/v1/...
       → 服务器 Nginx（LAN_AI_UPSTREAM）
       → 127.0.0.1:18000
       → frps ←隧道→ 家里 frpc → 192.168.6.78:8000 Grok2API
```

---

## 一、公网服务器（38.246.112.19）

### 1. 更新代码

```bash
cd ~/apps/infinite-canvas
git pull
```

### 2. 准备 frps 配置

```bash
cd ~/apps/infinite-canvas/deploy/lan-tunnel
cp frps.toml.example frps.toml

# 生成 token（两边必须一致）
TOKEN=$(openssl rand -hex 24)
echo "你的 FRP_TOKEN=$TOKEN"   # 复制保存，家里 frpc 要用
sed -i "s/CHANGE_ME_TO_A_LONG_RANDOM_TOKEN/$TOKEN/" frps.toml
```

### 3. 启动 frps（仅本目录，不动主栈服务名）

```bash
cd ~/apps/infinite-canvas/deploy/lan-tunnel
sudo docker compose -f docker-compose.frps.yml up -d
sudo docker compose -f docker-compose.frps.yml ps
sudo docker compose -f docker-compose.frps.yml logs --tail 30
```

### 4. 防火墙放行 **仅 7000**（不要对公网放行 18000）

```bash
# ufw 示例
sudo ufw allow 7000/tcp comment 'frp control'
sudo ufw status
```

### 5. 主项目 `.env` 指向隧道出口

```bash
cd ~/apps/infinite-canvas
# 编辑仓库根目录 .env，增加或修改：
# LAN_AI_UPSTREAM=host.docker.internal:18000
grep -n LAN_AI .env || true
```

若没有该行：

```bash
echo 'LAN_AI_UPSTREAM=host.docker.internal:18000' >> .env
```

**不要**再写 `192.168.6.78:8000`（服务器到不了家）。

### 6. 重建 app 使 `/lan-ai` 生效

```bash
cd ~/apps/infinite-canvas
sudo docker compose -f docker-compose.local.yml up -d --build app
sudo docker compose -f docker-compose.local.yml logs app --tail 15
# 期望：LAN AI relay enabled: /lan-ai/ -> http://host.docker.internal:18000
```

### 7. 家里 frpc 起来之前

```bash
curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 3 http://127.0.0.1:18000/v1/models
# 可能失败/空——正常，等家里连上后再测
```

---

## 二、家里机器（能打开 192.168.6.78:8000 的电脑）

### 1. 拿到服务器上的 token

与服务器 `frps.toml` 里 `auth.token` 完全一致。

### 2. 配置 frpc

把仓库里 `deploy/lan-tunnel` 拷到家里，或只拷贝 example：

```bash
cp frpc.toml.example frpc.toml
# 编辑 frpc.toml：
#   serverAddr = "38.246.112.19"
#   auth.token = "与服务器相同"
#   localIP / localPort = 192.168.6.78 / 8000
```

### 3A. Linux 用 Docker 启动 frpc

```bash
cd deploy/lan-tunnel   # 家里的路径
sudo docker compose -f docker-compose.frpc.yml up -d
sudo docker compose -f docker-compose.frpc.yml logs -f
# 期望：start proxy success 之类
```

### 3B. Windows 用官方 frpc（无 Docker 时）

1. 打开 https://github.com/fatedier/frp/releases 下载 Windows amd64  
2. 解压后把 `frpc.toml` 放同目录  
3. 管理员 PowerShell：

```powershell
.\frpc.exe -c .\frpc.toml
```

可装成服务或开机任务，保持常开。

### 4. 本机确认 Grok2API 仍可访问

浏览器：`http://192.168.6.78:8000/login` 应仍可打开。

---

## 三、两端通了之后：验收

### 服务器上

```bash
# 隧道出口（应能打到家里 Grok，401 也算通）
curl -sS -o /dev/null -w "direct_tunnel %{http_code}\n" --connect-timeout 8 http://127.0.0.1:18000/v1/models

# 经 infinite-canvas 中继
curl -sS -o /dev/null -w "lan_ai %{http_code}\n" --connect-timeout 8 http://127.0.0.1:3001/lan-ai/v1/models
```

| 结果 | 含义 |
| --- | --- |
| `direct_tunnel` 超时 | frpc 没连上 / 家里 Grok 挂了 / token 错 |
| `direct_tunnel` 401/200，`lan_ai` 503 | app 未配 LAN_AI 或未 rebuild |
| `lan_ai` 504 | app 上游仍指错地址 |
| `lan_ai` 401/200 | **通路成功** |

### 浏览器

1. 打开 `http://38.246.112.19:3001`  
2. 配置 → 渠道 Base URL = **`/lan-ai`**（不要填 192.168）  
3. API Key = Grok2API **客户端 Key**  
4. 拉取模型  

---

## 四、日常运维

```bash
# 服务器看 frps
cd ~/apps/infinite-canvas/deploy/lan-tunnel
sudo docker compose -f docker-compose.frps.yml logs -f

# 家里看 frpc
sudo docker compose -f docker-compose.frpc.yml logs -f
# 或 Windows 看 frpc 窗口
```

| 停用隧道（恢复无 /lan-ai 家宽） | 命令 |
| --- | --- |
| 停家里 | `docker compose -f docker-compose.frpc.yml down` 或关 frpc.exe |
| 停服务器 frps | `docker compose -f docker-compose.frps.yml down` |
| 关中继 | 根目录 `.env` 去掉/清空 `LAN_AI_UPSTREAM` 后 `up -d --build app` |

主站 `docker compose -f docker-compose.local.yml` **不必** down。

---

## 五、故障排查

| 现象 | 处理 |
| --- | --- |
| frpc 连不上 server | 服务器防火墙 7000；安全组放行 7000；token/serverAddr |
| 18000 通但 /lan-ai 503 | `LAN_AI_UPSTREAM` + rebuild app |
| /lan-ai 504 | 上游仍不可达：frpc 日志、家里 8000、localIP |
| 拉取模型 401 | 前端 API Key；Grok2API 客户端令牌 |
| 公网扫描 7000 | 正常需暴露控制口；token 必须够长；可后续改端口 |

---

## 六、不要提交的文件

- `deploy/lan-tunnel/frps.toml`
- `deploy/lan-tunnel/frpc.toml`
- 任何含真实 token 的文件  

仓库只保留 `*.example` 与 compose/README。
