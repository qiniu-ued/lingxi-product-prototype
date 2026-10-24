# 运行、交付与更新

## 部署在哪里

部署在使用者的 Mac，无需云服务器。Electron 桌面应用管理独立 Node 24 服务、Codex App Server、SQLite 和唯一作品页面。安装后日常启动/退出无需终端；灵矽音频和 AirPlay 自动配对仍未接入。静态网站托管无法获得本机执行能力。

`127.0.0.1` 属于浏览器所在电脑，云工作区运行不代表用户的 Mac 已运行。当前开发者没有远程控制用户 Mac 的入口，真机验收由用户本机配合。

## 桌面应用（推荐）

在 [Actions → CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml) 选择对应分支/PR/提交的全部通过运行，登录 GitHub 下载对应 artifact：

| Mac                    | Artifact 前缀             | 桌面 ZIP                        |
| ---------------------- | ------------------------- | ------------------------------- |
| Apple Silicon / M1 Pro | `runtime-macos-15-`       | `Lingxi-0.1.0-darwin-arm64.zip` |
| Intel                  | `runtime-macos-15-intel-` | `Lingxi-0.1.0-darwin-x64.zip`   |

版本以实际文件名为准。解开 GitHub 的 artifact ZIP，再解开内部桌面 ZIP，把 `Lingxi.app` 拖入「应用程序」。包内含 Node 24、npm 11、网页、服务和目标架构 SQLite；用户不用预先安装 Node/npm。Codex CLI 按需在向导另行安装 latest，需要网络与账号授权。

这是**未进行 Developer ID 签名和公证的开发预览**。校验来源与 `.sha256` 后，首次被系统阻止时，可按 macOS「系统设置 → 隐私与安全性 → 仍要打开」对这个可信应用单独放行，具体入口随系统版本变化。不要关闭全局 Gatekeeper 或使用递归去隔离属性命令。受组织策略限制时需等待签名/公证版本。严格免终端且不经系统放行的正式分发，还需要维护者提供 Apple Developer 签名与公证配置。

打开应用 → 连接向导 → 配置 Codex → 新建/打开项目 → 提交指令。项目入口是 `preview/index.html`，只支持本地静态资产，暂不运行任意 dev server、CDN 或外部 API。大屏窗口持有实际页面，电脑端显示实时截图，可点选修改；Cmd+Q、应用菜单退出或关闭操作台会停止受控服务/任务。关闭大屏仅隐藏窗口。

数据位于 `~/Library/Application Support/Lingxi/`：数据库、托管 CLI、项目注册表、冻结资产；Electron 项目 session 的 localStorage 也在应用数据目录。安装目录可以替换，数据不随包删除。不要同时启动桌面版与使用相同数据路径的终端服务。桌面服务端口随机，由应用自动使用；不需要手动打开 4310。

## 从源码运行与终端备用模式

需要 Git、Node.js **24.x**、npm **11.x**。检查 `node --version` 与 `npm --version`。SQLite 有原生依赖；如果安装需要本机编译工具，macOS 可先执行 `xcode-select --install`。

首次拉取（未合并的新功能按对应 PR 切换分支；已合并功能使用默认分支）：

```sh
git clone https://github.com/qiniu-ued/lingxi-product-prototype.git
cd lingxi-product-prototype
npm ci
```

完整桌面开发使用 `npm run desktop:dev`，修改源码后退出并重新运行。以下为独立浏览器基础模式，只保存建议和同步，不执行 Codex 任务。

开发时运行 `npm run dev`，打开 <http://127.0.0.1:5173/> 与 <http://127.0.0.1:5173/display>，支持自动重载。停止用终端里的 Ctrl+C。

日常运行使用编译结果，网页和 API 共用一个服务：

```sh
npm run build
LINGXI_DB_PATH="$HOME/Library/Application Support/Lingxi/lingxi.db" npm start
```

打开 <http://127.0.0.1:4310/> 和 <http://127.0.0.1:4310/display>。保持终端进程运行，Ctrl+C 停止；该备用模式没有登录自启或后台服务安装器；桌面版由应用管理生命周期。

首次配置从 <http://127.0.0.1:4310/setup> 开始。只有 Codex 桌面应用、尚未注册灵矽的完整准备步骤见 [Mac 连接指南](mac-setup.md)。

## 兼容的终端运行包

在仓库 [Actions → CI](https://github.com/qiniu-ued/lingxi-product-prototype/actions/workflows/ci.yml) 选择**全部通过**的运行，在 Artifacts 下载对应文件，需要有仓库读取权限并登录 GitHub：

| 电脑                                   | Actions artifact 名称前缀 | 内部 tar.gz 后缀      |
| -------------------------------------- | ------------------------- | --------------------- |
| Apple Silicon（`uname -m` 为 `arm64`） | `runtime-macos-15-`       | `darwin-arm64.tar.gz` |
| Intel（`uname -m` 为 `x86_64`）        | `runtime-macos-15-intel-` | `darwin-x64.tar.gz`   |

建议使用 macOS 15 或更新版本；CI 使用 macOS 15，两种架构分别验证。包内包含网页、编译后的服务、生产依赖和 SQLite 原生模块，**仍需先安装 Node.js 24.x**，无需再运行 `npm ci`。这不是独立 `.app`，未进行代码签名、公证，也没有自动更新。

先解开 GitHub 下载的 artifact ZIP。以 Apple Silicon 的 0.1.0 为例，在包含以下文件的目录执行：

```sh
shasum -a 256 -c lingxi-workbench-0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf lingxi-workbench-0.1.0-darwin-arm64.tar.gz
cd lingxi-workbench-0.1.0-darwin-arm64
./start.sh
```

Intel 替换为 `darwin-x64`；版本号以实际文件为准。若 Node 版本或包的架构不匹配，启动器会报错。启动后使用 4310 的两个地址。包内 `runtime-manifest.json` 记录版本、源码提交、操作系统、架构和 Node 主版本，可以据此确认安装来源。

运行包通过 npm 锁文件在目标 Mac runner 上安装生产依赖，再压缩、解压并启动验证。不要将一台电脑的 `node_modules` 直接复制到另一种架构。

## 数据、配置与日志

| 设置                             | 行为                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| 源码 `npm start` 的数据默认值    | 仓库 `.local/lingxi.db`，建议日常使用时显式指定外部路径              |
| 运行包 `./start.sh` 的数据默认值 | `~/Library/Application Support/Lingxi/lingxi.db`                     |
| `LINGXI_DB_PATH`                 | 覆盖 SQLite 文件位置，自动创建父目录；路径包含空格时加引号           |
| `PORT`                           | 默认 4310，端口被占用时可指定其他本机端口                            |
| `LINGXI_WEB_ORIGIN`              | 开发网页来源，默认 `http://127.0.0.1:5173`；正常生产同源运行无需设置 |
| 日志                             | 输出到启动服务的终端；当前没有录音或供应商密钥写入功能               |

例如 `PORT=4320 ./start.sh` 后打开 `http://127.0.0.1:4320/`。服务只监听 `127.0.0.1`；当前不接受局域网其他设备加入。同一个数据库只启动一份工作台服务，多开浏览器窗口即可。

Codex 环境检查默认通过服务的 PATH 查找 `codex`。自定义位置可设置 `LINGXI_CODEX_BIN` 为可执行文件绝对路径；页面不能修改此值，也不接收任意程序或参数。

## 大屏使用

在 Mac 控制中心连接 AirPlay 电视或会议室屏幕。支持扩展显示时，把 `/display` 浏览器窗口移动到大屏并全屏，电脑保留 `/` 操作台；只能镜像时，电视显示与笔记本相同画面。先在同一台 Mac 打开两个窗口验证同步，再投屏。麦克风距离、回声、真实 Codex 和 AirPlay 稳定性需要另做真机验收。

## 更新、备份和回退

1. 桌面版通过 Cmd+Q 退出，终端模式 Ctrl+C 停止服务，确认旧进程退出。
2. 备份数据目录。SQLite 可能有 `lingxi.db-wal`、`lingxi.db-shm`；服务停止后备份整个目录，避免只复制仍在写入的主数据库。
3. 桌面版备份旧应用，再替换为已通过 CI 的新 `.app`；终端版解压到新版本目录，使用相同外部数据库路径。没有自动更新器。
4. 检查 `/api/health`、已有建议、操作台提交与大屏同步，再结束更新。

当前 schemaVersion 为 1，桌面功能通过增加 `workbench_state` 与 `workbench_requests` 表实现，原会话表不变；旧版忽略新表，不删除或降级。未来有数据格式变更时必须提供迁移与兼容说明。相同数据格式可以停止新版并启动旧包回退；若升级改变数据格式，应恢复升级前备份并运行对应旧版，升级后新增的数据需另行保留。不要通过删除数据库来修复启动问题。

源码更新也先停止和备份，再在目标分支 `git pull --ff-only`、`npm ci`、`npm run build`，使用原来的外部数据库路径启动。

## CI/CD 如何工作

PR、推送 main 或手动触发 CI 都执行静态/类型检查、覆盖率、生产启动与重启恢复、Chromium 双端测试；Linux 还执行生产依赖审计和 workflow 语法检查。通过后，在 Apple Silicon 与 Intel Mac 分别构建运行包，以及含 Node/npm 的桌面 ZIP；解压 ZIP 后启动真实 `.app` 验证同页 MCP、退出和重启，再上传。覆盖率报告保存 7 天，运行包保存 14 天，长期版本发布可在后续接 GitHub Releases。

当前 CD 完成的是**经验证的运行包交付**，安装由使用者手动执行，不会自动修改任何人的 Mac。手动触发入口需要 workflow 先存在于默认分支；基础工程 PR 可以通过 PR 检查自动获得包。Dependabot 配置合并到默认分支后每周检查 npm 与 Actions 更新，更新 PR 仍需通过同一套 CI，不自动合并。

维护者本机可运行 `npm run release:pack`，产物位于 `artifacts/`，只针对执行机器的操作系统与架构。流程不需要 Codex、灵矽或部署密钥。检查细节见 [测试策略](testing.md)。

维护者在目标 Mac 上执行 `npm run desktop:pack`，产物在 `artifacts/`，含兼容终端包和桌面 ZIP；不支持在 Linux 伪造 Mac 应用。桌面 ZIP 会先通过集成检查再交付。代码签名、公证、自动更新和发布到 GitHub Releases 均未自动执行。
