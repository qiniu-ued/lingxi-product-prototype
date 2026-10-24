# 灵矽共创工作台

[![CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml)
[![Codecov](https://codecov.io/gh/qiniu-ued/lingxi-product-prototype/branch/main/graph/badge.svg)](https://app.codecov.io/gh/qiniu-ued/lingxi-product-prototype)

在沙发或会议室里提出想法，让 Codex 制作产品，大家在大屏上看进展、体验作品，再继续修改。目标支持七牛灵矽语音、鼠标点选和键盘输入。

当前分支提供 **Mac 桌面入口、Codex 任务和同一个作品页面的预览控制**。采用 Electron + React + TypeScript + Node.js 24。灵矽音频、自定义唤醒词和 AirPlay 自动配对尚未接入；当前麦克风不会启用。设计师的原始演示保留在 `source/` 和根 `dist/`，其中语音和投屏仍是预设剧情。

## 在 Mac 使用

从 [Actions → CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml) 对应 PR/提交的全部通过运行下载 `runtime-macos-15-<commit>`（Apple Silicon）或 `runtime-macos-15-intel-<commit>`。解开 artifact，再解开其中的 `Lingxi-0.1.0-darwin-arm64.zip` / `darwin-x64.zip`，将 `Lingxi.app` 拖到「应用程序」并打开。**桌面包内置 Node、npm 和本机服务，日常启动与退出不需要终端。**

当前是未签名、未公证的开发预览包，macOS 可能阻止首次打开；可信来源包的放行方式及校验见[部署文档](docs/deployment.md)。若组织策略禁止未签名应用，需等待签名版本。不要关闭全局 Gatekeeper。
1. 打开「连接向导」，一次查看 Codex 和灵矽检查结果；按需一键安装 stable latest Codex CLI，并在官方浏览器登录。仅有 Codex 桌面应用时仍需要 CLI。
2. 新建或打开一个允许 Codex 修改的项目文件夹，输入本轮要求并提交。额外权限和问题在操作台处理，随时可停止任务。
3. 第一版作品入口为项目里的 `preview/index.html`，支持本地 HTML / CSS / JavaScript。Codex 完成一轮后发布可用预览；已有项目可点「刷新作品」。暂不启动任意项目的开发服务器。
4. 大屏窗口持有唯一的作品页面，电脑端显示它的实时截图。「点选修改」选择元素后输入要求；需要体验按钮和表单，可直接操作大屏窗口，也可要求 Codex 点击、输入或滚动。
5. AirPlay 暂由 macOS 控制中心连接。选择扩展显示后打开大屏，应用优先放到外接屏；需要时自行移动窗口。连接电视和系统 PIN 由 macOS 管理。
6. 关闭操作台窗口，或菜单「退出灵矽」，会停止应用启动的服务与任务。关闭大屏窗口只隐藏大屏，不取消任务。文件修改不会因停止任务而回退。

真实提供方登录、模型调用、M1 Pro 麦克风和电视仍需要本机验收；协议替身测试不算这些能力已验证。你可以在本机登录并绑定灵矽设备，无需向开发者发送密码或密钥。当前向导尚不能自动绑定或验证灵矽设备。

## 从源码开发

需要 Node.js **24.x**、npm **11.x**：

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` 编译后启动桌面应用；修改源码后退出并重新运行。纯浏览器基础模式使用 `npm run dev`，操作台 <http://127.0.0.1:5173/>、大屏 `/display`、向导 `/setup`，保留建议保存和同步功能。独立浏览器服务没有桌面预览控制，也不会执行 Codex 任务。

```sh
npm run check
npm run test:e2e
npm run test:desktop
npm run audit:production
# 在目标架构的 Mac 构建桌面 ZIP 与兼容的终端运行包
npm run desktop:pack
```

- [Mac 连接与验收指南](docs/mac-setup.md)
- [运行、打包、部署、更新与回退](docs/deployment.md)
- [开发与工程结构](docs/development.md)、[测试与 Codecov 配置](docs/testing.md)
- [产品设计](docs/product-design.md)、[系统架构](docs/architecture.md)、[桌面与预览 ADR](docs/adr/0003-desktop-canonical-preview.md)
- [设计对齐、唤醒词与自动投屏计划](docs/desktop-voice-plan.md)、[实施清单](docs/roadmap.md)

覆盖率徽章展示主分支数据；私有仓库需要在 Codecov 侧启用服务，CI 绿色不代表外部上传成功。
