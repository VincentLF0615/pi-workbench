# 应用图标与品牌说明

Pi Workbench 是个人使用的非官方 Pi 桌面客户端，与 Pi 或 Earendil 无官方
隶属、赞助或背书关系。

## 应用图标（原创设计）

本项目当前的应用图标为**原创设计**：「折纸 π」——彩虹渐变的屋顶
横杠（品红→紫→蓝→粉→黄）压在紫罗兰色左腿与青蓝→薄荷绿右腿之上，
柱间保留深色空腔，折痕处有高光。图标为**透明背景**：脚本从设计源稿
裁切母本后把深色底泛洪抠除，字形悬浮于系统背景之上，浅色/深色主题
皆可。设计源稿存于
`docs/icon-reference/pi-workbench-icon-board.png`，
`tools/make-icons.py` 从源稿抠底、居中并重采样出全部尺寸。配色取自
Pi 公开品牌形象的色板气质，构图不复现任何官方标志。

- 设计稿与导出脚本：`tools/make-icons.py`（Pillow 绘制，4 倍超采样）
- 应用内品牌图：`apps/desktop/src/assets/pi-mark.png`
- 桌面图标：`apps/desktop/src-tauri/icons/`（含多尺寸 `.ico` 与 `.icns`）

## 历史说明

0.1.0 至 0.1.1 期间，应用曾直接使用 Pi 官方 Press Kit 的彩色标志作为
图标（获取日期 2026-11-15）。为避免公开分发时的商标问题，现已替换为
上述原创设计，仅保留配色上的致敬。

"Pi" 及其官方标志归其相应权利人所有。本项目不主张拥有这些标志，也不
将代码许可证视为对品牌标识使用范围的额外授权。MIT 许可证仅覆盖本项目
的代码与原创美术作品，不授予使用 Pi 官方品牌的任何权利。

## 内置 pi agent 的再分发

安装包附带一份 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
（© 2025 Mario Zechner，MIT License）。MIT 允许再分发，条件是随附许可
证文本与版权声明，本项目按以下方式履行：

- `vendor-pi/LICENSE`：随安装包分发的 MIT 许可证原文（另存于
  `docs/third-party/pi-agent-LICENSE.txt`）
- `tools/vendor-pi.ps1`：从 npm registry 拉取指定官方发布包（`--ignore-scripts`），
  使用 npm registry 的 SHA-512 完整性值校验后再解包，不修改包内容
- README「致谢」段落注明上游项目

应用"设置 → 关于"提供来源说明，安装包附带 `branding-notice.txt`。
