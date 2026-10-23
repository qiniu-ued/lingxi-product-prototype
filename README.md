# 灵矽 · 主动唤醒与语音创作原型

这是用于产品评审的 14 步交互流程原型，展示无屏控制端、AirPlay 连接、语音创作、Agent 状态、作品操作与修改、断线及重连。

## 文件

- `source/lingxi-voice-prototype.html`：可编辑的交互原型片段。
- `dist/index.html`：可直接托管的独立网页，包含样式、交互及独立运行包装。

## 使用

打开网页后，点击「自动演示」播放流程，或用「上一句」「下一句」逐步评审。演示控件位于产品画面之外；所描绘产品由总发言人主动唤醒后，通过语音提交需求。每次提交后结束收音，Agent 独立执行；补充需求、查询进度和修改作品均需再次主动唤醒。唤醒方式尚未接入真实硬件。

语音、AirPlay、Agent 执行及断线恢复均为预设剧情模拟。本版本没有调用麦克风、AirPlay 协议栈、Claude Code 或其他 Agent 服务，也不保存真实会话。刷新页面会回到第 1 步。

## 运行与发布

这是无需构建的静态站点。静态根目录为 `dist`。在仓库根目录运行：

```sh
python3 -m http.server 8080 --directory dist
```

浏览器打开 `http://localhost:8080`。部署时将 `dist` 作为静态目录，并为托管服务单独配置访问权限。

现有演示：https://lingxi-voice-prototype.livelydell4096.chatgpt.site（公开可访问；GitHub 源码仓库仍为私有，二者权限独立）。

方案背景：[灵矽产品方案分析](https://chatgpt.com/c/6adae580-8d14-83ec-865c-9eaa25300083)。

本仓库为私有仓库，用于内部方案展示和代码协作。

独立页面由 Visualize 的 `scripts/render.py` 从源片段导出，并将内外文档语言设为 `zh-CN`。图标使用导出包装中的固定版本 Lucide；本原型不发起业务 API 请求。
