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

## 准备 Codex

保留工作台运行，另开一个终端标签页执行以下命令。Codex 桌面应用和 CLI 的安装入口不同，本工作台通过 CLI 的 App Server 接口接入，先安装固定版本：

```sh
npm install -g @openai/codex@0.164.0
codex --version
codex login status
```

0.164.0 是本次向导引用的官方稳定版本。检测会报告实际版本，后续执行适配器应继续固定 CLI 和对应协议类型。已安装其他版本时，不会由工作台自动升级或替换。

如果已有登录有效，继续使用；若未登录，执行 `codex login`，在授权网页完成登录。不要把账号 token 或 API Key 粘贴进工作台。桌面应用可以继续使用，向导会通过 App Server 确认 CLI 的实际登录状态。

回到向导「准备 Codex」点击「检测 Codex 环境」。检查只调用版本命令，短暂启动 `codex app-server`，完成 `initialize` / `initialized`，再调用 `account/read`（`refreshToken: false`），读取登录类型后关闭进程。

不会创建线程、执行 `turn/start`、修改项目或启动登录流程；不会读取凭据文件，也不会把邮箱、密钥或原始提供方错误返回页面。CLI 的启动和配置加载仍由 Codex 自身负责。检查有超时和输出大小限制，并回收子进程。同一时刻重复请求共享正在进行的检查。

检测结果包括：未安装、未登录、环境检查通过、失败或超时。环境通过仅表示版本命令、App Server 握手和认证配置可读取；不代表模型调用成功、额度可用、项目权限已批准或任务执行已经接入。

找不到 CLI 时，在终端运行 `command -v codex`，从相同终端重新启动工作台。自定义安装位置可在服务启动时指定：

```sh
LINGXI_CODEX_BIN="/absolute/path/to/codex" npm start
```

路径必须是可执行文件本身，不能包含命令参数。网页不接收任意程序或 shell 命令。向导当前不自动接管 Codex 桌面应用已有的会话。

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
