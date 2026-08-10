# 3D 导演台静态资源（嵌入用）

本目录为 [storyai-3d-director-desk](https://github.com/jiguang132/storyai-3d-director-desk) 的 **构建产物**，供无限画布以 **同域 iframe**（`/director-desk/index.html`）嵌入。

- 协议：`src/editor/io/hostBridge.ts`（旁路克隆，已补 opener + BroadcastChannel）↔ 宿主 `web/src/lib/director-desk.ts`
- 新窗口：宿主 `window.open` **不**带 `noopener`；子页 `postToHosts` 投 parent/opener/广播
- 许可：见同目录 `LICENSE`（MIT）
- **不要**在本目录手改业务逻辑；上游更新后在旁路仓库构建再覆盖复制

## 重建步骤（维护者）

```bash
# 旁路克隆目录（不在本 monorepo 内）
cd ../storyai-3d-director-desk
# Windows 需去掉 package.json 里的 @rollup/rollup-darwin-arm64 后再 npm install
npm install
# base 应为 "./"（相对路径，便于子路径托管）
npm run build
rm -rf ../infinite-canvas/web/public/director-desk/*
cp -a dist/. ../infinite-canvas/web/public/director-desk/
cp LICENSE ../infinite-canvas/web/public/director-desk/
```

## 关闭 / 回退

1. 构建时 `VITE_DIRECTOR_DESK_ENABLED=false`
2. 或浏览器 `localStorage.setItem('infinite-canvas:director-desk-enabled','0')` 后刷新
3. 或删除本目录 + 入口相关文件（见 `web/src/lib/director-desk.ts` 注释）
