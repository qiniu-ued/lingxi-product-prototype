# Mac 首次运行与连接准备

适用于只有 Codex 桌面应用、尚未创建灵矽账号的起点。工作台提供 `/setup` 连接向导，可从操作台顶部「连接向导」进入。向导检查环境并提供操作步骤；当前自动修改代码、项目预览和灵矽语音控制仍未开放。

## 先把工作台跑起来

安装 [Node.js 24.x](https://nodejs.org/en/download)，确认终端中的 `node --version` 为 24.x、`npm --version` 为 11.x。私有仓库拉取需要 GitHub 访问权限，沿用你的本机 GitHub 登录方式。

```sh
git clone https://github.com/qiniu-ued/lingxi-product-prototype.git
cd lingxi-product-prototype
npm ci
npm run build
LINGXI_DB_PATH="$HOME/Library/Application Support/Lingxi/lingxi.db" npm start
```

保留终端窗口，打开 <http://127.0.0.1:4310/setup>。开发模式可用 `npm run dev`，地址为 <http://127.0.0.1:5173/setup>。Ctrl+C 停止。下载运行包则解压后执行 `./start.sh`，数据默认已经位于上述外部目录，详见 [部署文档](deployment.md)。

首次体验尚未合入的向导分支时，在 `npm ci` 前执行 `git switch feat/mac-connection-guide`；合并后默认分支即可使用。已下载过仓库时先停止服务，再 `git pull --ff-only`、`npm ci` 和 `npm run build` 后重新启动，保留原数据路径。

浏览器中的 `127.0.0.1` 属于当前电脑。向导显示的是后端服务所在电脑的系统、架构和 Node 版本；云端环境的检测不能作为 Mac 已配置好的证据。

## 先检查两项环境，再配置 Codex

打开向导会发起一次环境检查，同时返回本地服务、Codex 与灵矽的检测结果，再展示两步配置建议。已有 Codex 和认证配置时直接建议准备灵矽；缺少 CLI 才显示安装按钮，未登录才显示授权按钮。灵矽检测适配器尚未接入，结果明确为「暂无法检测」，不推断账号或设备是否已配置。

只读检查调用 `codex --version`，短暂启动 `codex app-server`，完成 `initialize` / `initialized`，再调用 `account/read`（`refreshToken: false`）。读取登录类型后关闭进程。检查不会安装、登录、创建线程或执行任务，不直接读取凭据文件；邮箱、密钥和原始提供方错误不会返回页面。同一时刻的检查共享运行，超时或异常后回收子进程。

### 通过页面安装与登录

- 缺少 CLI：点击「一键安装最新版 Codex」。本地 Node 服务调用固定的 `npm install --prefix <工具目录> --save-exact --no-audit --no-fund @openai/codex@latest`，需要 npm 和网络。使用稳定通道最新版，安装完成后报告实际版本，并检查 App Server 协议是否可用。
- 安装位置：数据库所在目录的 `tools/codex-<UUID>/`，运行包默认在 `~/Library/Application Support/Lingxi/tools/`。每份安装保留 npm 的 package.json 与锁文件；验证通过才原子切换 `codex-current.json` 指针。失败不替换原来使用的安装。已有全局 CLI 不自动升级，也不需要 sudo。
- 尚未登录：点击「在浏览器登录 Codex」。本地服务通过 App Server 的 `account/login/start` 发起 ChatGPT 登录，在官方网页完成授权。如果浏览器拦截新窗口，点击「打开官方授权页」。服务等待与该次 loginId 对应的完成通知，再复查账号配置；不让网页收集密码或 token。
- 页面刷新后会继续读取当前操作。可停止安装或停止等待登录；关闭工作台服务会回收它启动的进程。停止不撤销已经完成的安装或授权。操作状态保存在服务内存，服务重启后会重新检查实际环境；重启不会自动重试安装或登录。请求 ID 在当前服务内去重，最多保留最近 20 次记录。

浏览器本身不能执行 shell。按钮只请求本地服务的固定安装、登录、取消操作，接口不接受命令文本、程序路径或参数。操作串行执行，安装和登录 POST 必须具有允许的本地 Origin；服务仍只监听回环地址。灵矽目前提供官方配置入口，尚不能在此一键安装或授权。

### 终端备用方式

也可以保留工作台运行，在另一个终端标签页自行配置。只有桌面应用时需安装 CLI；已有 CLI 先检查即可：

```sh
npm install -g @openai/codex@latest
codex --version
codex login status
# 未登录时再执行
codex login
```

页面安装由工作台单独管理，终端里的 `codex` 可能指向另一份安装。服务选择顺序为 `LINGXI_CODEX_BIN` → 工作台管理的 CLI → PATH 中的 CLI。设置了自定义路径时，页面不另行安装一个不会被选用的版本；请在终端维护该安装。首次使用 PATH 安装若找不到程序，执行 `command -v codex`，从相同终端重新启动工作台；也可指定可执行文件的绝对路径：

```sh
LINGXI_CODEX_BIN="/absolute/path/to/codex" npm start
```

路径不能包含命令参数。诊断通过仅表示版本命令、App Server 握手和认证配置可读取，不代表模型调用、额度或项目权限已验证。向导不会接管 Codex 桌面应用已有会话；真实任务执行仍待接入。测试使用固定的协议替身验证契约，用户安装入口使用 latest；未来任务适配器需记录测试过的 CLI 与协议范围。

## 准备灵矽

1. 在[七牛灵矽控制台](https://xrobo.qiniu.com/)注册/登录，创建专用于工作台的智能体。
2. 按[官方 Mac 音频客户端文档](https://linx.qiniu.com/docs/xrobot/guide/client-demo)安装依赖并编译运行。官方示例为 C++ 客户端，macOS 使用 PortAudio；工作台运行包目前不包含该客户端。
3. 按[设备绑定指南](https://linx.qiniu.com/docs/xrobot/guide/quick-start)，用客户端提供的设备验证码绑定智能体。
4. 在「系统设置 → 隐私与安全性 → 麦克风」授权运行客户端的应用，检查输入/输出设备；先确认测试语句能被识别，并能听到回复。

完成以上步骤只验证灵矽音频链路。还需实现端侧 MCP 与工作台之间的提交、查询、补充和停止工具，才能语音控制 Codex。连接向导目前不采集灵矽凭据、不自动验证云端绑定，也不把手动准备步骤标成真实连接成功。

后续优先通过 Mac 主动建立的连接接入[端侧 MCP](https://linx.qiniu.com/docs/xrobot/mcp/hardware-mcp)。独立异步播报、远场拾音、回声和多人发言仍需真机验证。

## 连接大屏并验收

在同一台 Mac 打开操作台 `/` 与大屏 `/display`，保存一条建议，确认同步。然后在 macOS 控制中心连接 AirPlay；支持扩展显示时将大屏窗口移到电视并全屏，电脑保留操作台。只能镜像时两块屏幕画面一致。

先验证保存、刷新恢复、双端同步和投屏画面；语音修改代码需等待真实任务与语音适配器接入。参考 [接入边界](integrations.md) 与 [实施清单](roadmap.md)。
