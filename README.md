# 灵矽产品需求说明

## 产品定位

灵矽是一款面向多人共同讨论场景的语音应用。用户主动唤醒灵矽，通过语音调用 Claude Code 或其他 Code Agent 完成编程开发，并在公共屏幕上直接查看、体验和修改结果。

屏幕连接可以采用 AirPlay 或其他兼容协议，具体方案根据控制端与电视设备能力确定。

## 工程与设计

当前方案支持语音、鼠标和键盘共同操作，由 Mac 上的本地服务调用 Codex，浏览器展示操作台和大屏。技术栈为 React + TypeScript + Node.js，当前基础工程实现建议保存和双端同步，真实 Agent 与语音尚待接入。
- [当前产品设计](docs/product-design.md)
- [技术架构与 ADR](docs/adr/0001-local-web-architecture.md)
- [开发、运行与工程结构](docs/development.md)
- [测试策略](docs/testing.md) 与 [实施清单](docs/roadmap.md)

快速开始（Node.js 24.x、npm 11.x）：

```sh
npm ci
npm run dev
```

操作台：<http://127.0.0.1:5173/>，大屏：<http://127.0.0.1:5173/display>。
