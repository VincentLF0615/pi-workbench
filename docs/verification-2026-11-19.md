# Pi Workbench 交互与发布验证记录（2026-11-19）

## 范围与边界

- 本机 Pi 1.5.2；Rust + Tauri 2 + React 19；Windows 11。
- 离线 GUI 验证使用 `crates/pi-rpc/tests/support/mock-pi.cjs`、隔离的 `PI_WORKBENCH_DATA_DIR` 和测试项目，不调用模型、不覆盖正式应用设置。
- 原生目录选择器、WebView2 CDP 和真实 Pi RPC 分别验证；测试不是单张截图推断。
- CDP 的 IME 测试是真实 WebView 组合输入事件，但不等同于人工使用某一种中文输入法。

## 自动化

- 84 项 Rust 测试通过，2 项 opt-in 测试保持默认忽略。
- 40 项前端测试通过。
- `cargo fmt --check`、严格 Clippy、TypeScript、前端生产构建通过。
- 覆盖队列/停止恢复、失败分支、弹窗焦点与 Esc、目录选择及失败回退、菜单键盘操作、重命名/删除、转录滚动、Bash 折叠、扩展状态清理、代码复制和安全链接。

## 真实 Tauri / WebView 验收

- 原生 Windows 目录选择器成功选择并打开含中文和空格的项目目录。
- 会话菜单的 Home/End/Esc、重命名、删除取消、面板开关和会话树通过。
- 扩展通知 warning、状态栏文本、dock widget、原生窗口标题通过；`handled` 命令保持 idle。
- IME 组合期间按 Enter 不发送；提交中文后正常进入会话。
- 强制 WebView DPR=1.5，960×600 CSS 视口下无横向溢出，输入区完整位于视口内。没有修改 Windows 的全局显示设置。
- 第一轮另行验证了 steer/follow-up 队列、停止恢复、压缩取消和最小窗口布局。

## 长会话性能基线

测试数据：200 轮用户/助手历史、40 个 Bash 卡片，共 441 行、约 4009 个 DOM 节点。以下为同机单次 CDP 测量，用作回归基线而非严格统计结论。

| 场景 | 平均帧 | P95 帧 | 最大帧 | 长任务 |
| --- | ---: | ---: | ---: | ---: |
| 441 行连续滚动 | 3.32ms | 3.50ms | 5.60ms | 0 |
| 流式更新（memo 前） | 4.92ms | 6.90ms | 82.60ms | 5，最长约 131ms |
| 流式更新（Row memo 后） | 3.79ms | 4.00ms | 28.30ms | 0 |

结论：保留全量渲染，对不变历史行使用 `React.memo`；当前规模不需要引入虚拟化。更大会话应复用本基线重新测量。

## 真实模型 smoke

- 默认 `magpie/codex/gpt-6.1-sol` 分别在 60 秒和 120 秒超时；有 assistant pending，但没有 delta 或错误事件。这是当前默认 provider 链路的待排查项。
- 改用 `magpie/stepfun-cn/step-3.7-flash` 后，约 1.62 秒收到预期标记 `PI_WORKBENCH_OK_20261119` 并正常 `agent_settled`。
- 这证明真实模型 RPC 链路可用，但不证明所有 provider 当前均可用；默认模型的超时仍应保留在发布检查中。

## 发布包 smoke

- `tools\bundle.ps1` 成功产出 NSIS 与 MSI；未执行公开发布、版本升级或正式安装覆盖。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `nsis/Pi Workbench_0.1.1_x64-setup.exe` | 1,876,519 | `6051B97A4111D9339E49502B36778940F488DB18B507053786C0A0D7666AD46D` |
| `msi/Pi Workbench_0.1.1_x64_en-US.msi` | 2,699,264 | `D46D6BF07D00994892FD516191E95ED07023297C736FD463F48437BE1BEA2D12` |

- 使用 `msiexec /a` 将 MSI 管理展开到 `C:\Users\LuoFeng\pi-workbench-test\msi-admin-20261119`；日志明确记录 `Installation completed successfully`。首次包装命令因 `$LASTEXITCODE` 为空而误报失败，不是 MSI 安装失败。
- 从展开目录直接启动生产 `pi-workbench.exe`，使用独立 `PI_WORKBENCH_DATA_DIR`、离线 mock Pi 和本地 CDP 9223。页面来源为 `http://tauri.localhost/`，确认加载内嵌生产前端。
- 成功打开含中文和空格的项目路径，建立离线 Pi 会话并渲染 45 条转录，无错误提示。
- 实际弹出原生 `#32770` 目录选择器，所属进程路径确认为上述 MSI 展开目录中的发布可执行文件；取消后“选择中…”状态正常复位。发布包的 dialog capability 因而经过真实调用验证。
- 截图保存于 `C:\Users\LuoFeng\pi-workbench-test\gui-release\release-smoke.png`。本项是隔离发布包 smoke，不是完整安装器交互或全功能回归。

## 品牌与发布

- 已复查 https://pi.dev/press-kit；页面提供素材，但没有额外写明商标授权范围。
- 保留非官方/无背书说明、原始 SVG 几何和颜色以及 `branding-notice.txt`。
- 不声称获得额外品牌授权，不在此验证中执行公开发布。
