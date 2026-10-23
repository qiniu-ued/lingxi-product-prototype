# 运行、交付与更新

## 部署在哪里

当前部署目标是使用者的 Mac：Node.js 本地服务管理 SQLite 和会话，浏览器显示电脑操作台与大屏。之后 Codex App Server 与灵矽音频适配器也在该 Mac 上接入。无需云服务器；仅把静态页面部署到网站托管平台无法获得本机执行能力。

目前版本实现建议保存、双端同步和恢复，尚未调用 Codex、录音或执行代码。运行不需要模型密钥。AirPlay 由 macOS 手动建立，浏览器不控制系统投屏。

`127.0.0.1` 指打开浏览器的那台电脑。云端工作区启动的服务不会因此运行在你的 Mac，也不能访问 Mac 上的 Codex。远程启动本机进程需要已连接的本机执行入口；本项目尚未提供远程安装或控制服务。

## 从源码运行

需要 Git、Node.js **24.x**、npm **11.x**。检查 `node --version` 与 `npm --version`。SQLite 有原生依赖；如果安装需要本机编译工具，macOS 可先执行 `xcode-select --install`。

首次拉取（未合并的新功能按对应 PR 切换分支；已合并功能使用默认分支）：

```sh
git clone https://github.com/qiniu-ued/lingxi-product-prototype.git
cd lingxi-product-prototype
npm ci
```

开发时运行 `npm run dev`，打开 <http://127.0.0.1:5173/> 与 <http://127.0.0.1:5173/display>，支持自动重载。停止用终端里的 Ctrl+C。

日常运行使用编译结果，网页和 API 共用一个服务：

```sh
npm run build
LINGXI_DB_PATH="$HOME/Library/Application Support/Lingxi/lingxi.db" npm start
```

打开 <http://127.0.0.1:4310/> 和 <http://127.0.0.1:4310/display>。保持终端进程运行，Ctrl+C 停止；当前没有登录自启或后台服务安装器。

首次配置从 <http://127.0.0.1:4310/setup> 开始。只有 Codex 桌面应用、尚未注册灵矽的完整准备步骤见 [Mac 连接指南](mac-setup.md)。

## 下载 Mac 运行包

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

1. 在原终端 Ctrl+C 停止服务，确认旧进程退出。
2. 备份数据目录。SQLite 可能有 `lingxi.db-wal`、`lingxi.db-shm`；服务停止后备份整个目录，避免只复制仍在写入的主数据库。
3. 将通过 CI 的新包解压到新版本目录，保留旧版本；使用相同 `LINGXI_DB_PATH` 或默认外部数据目录启动新版本。
4. 检查 `/api/health`、已有建议、操作台提交与大屏同步，再结束更新。

当前 schemaVersion 为 1，尚未实现数据库升级工具。未来有数据格式变更时必须提供迁移与兼容说明。相同数据格式可以停止新版并启动旧包回退；若升级改变数据格式，应恢复升级前备份并运行对应旧版，升级后新增的数据需另行保留。不要通过删除数据库来修复启动问题。

源码更新也先停止和备份，再在目标分支 `git pull --ff-only`、`npm ci`、`npm run build`，使用原来的外部数据库路径启动。

## CI/CD 如何工作

PR、推送 main 或手动触发 CI 都执行静态/类型检查、覆盖率、生产启动与重启恢复、Chromium 双端测试；Linux 还执行生产依赖审计和 workflow 语法检查。通过后，在 Apple Silicon 与 Intel Mac 分别构建、解压验证并上传运行包。覆盖率报告保存 7 天，运行包保存 14 天，长期版本发布可在后续接 GitHub Releases。

当前 CD 完成的是**经验证的运行包交付**，安装由使用者手动执行，不会自动修改任何人的 Mac。手动触发入口需要 workflow 先存在于默认分支；基础工程 PR 可以通过 PR 检查自动获得包。Dependabot 配置合并到默认分支后每周检查 npm 与 Actions 更新，更新 PR 仍需通过同一套 CI，不自动合并。

维护者本机可运行 `npm run release:pack`，产物位于 `artifacts/`，只针对执行机器的操作系统与架构。流程不需要 Codex、灵矽或部署密钥。检查细节见 [测试策略](testing.md)。
