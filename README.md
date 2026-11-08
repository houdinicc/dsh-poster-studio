# dsh-poster-studio · 海报工坊

一个**带左侧栏入口**的 DeepSeek Harness 插件：点左侧栏的「海报工坊」图标，中央面板打开一台海报工坊。
界面还原 DeepSeek Harness 创造模式视频里的那张「海报工坊」——**左边编辑文案与样式，右边实时预览海报**，
背景是官网（deepseek.com/harness）风格的 WebGL 流体 shader，文字用官网同款 Montserrat。

## 安装

```bash
dsh plugin add dsh-poster-studio
```

装完重启/刷新 DSH，左侧栏会多出一个「海报工坊」图标（顺序在「计划任务」之后）。点它，中央面板切到工作台；
再点会话图标回到对话（不需要面板内关闭按钮，走 shell 自己的导航）。

**本地开发安装**：在插件管理里安装本目录，或由代理执行 `plugin_manager` 的 `install_bundle`，`target` 传本目录绝对路径。
本地目录安装是软链接，改 `lib/client.js` 后刷新页面即可加载最新代码。

## 能做什么

- **文案**：眉标、主标题第一行、主标题第二行、中文副标题、说明文案、页脚、期号。改哪一项，右边海报立刻跟着变。
- **样式**：4 种画幅（4:5 `1080 × 1350`、1:1 `1080 × 1080`、3:4 `1080 × 1440`、9:16 `1080 × 1920`）、
  左对齐 / 居中、4 套配色（午夜 / 钴蓝 / 余烬 / 纸白）、模块图形开关、流动速度滑杆、恢复默认。
- **背景**：域扭曲 FBM + curl 流场的流体 shader，5 色平滑混合、暗角、颗粒、dither 防色带；
  WebGL 不可用时自动回落到 CSS 渐变，不会白屏。
- **字体**：官网首屏同款 **Montserrat**（拉丁 500 / 正文 400），woff2 以 data URI 内嵌，
  不联网、不依赖 CDN，随包附 SIL OFL 1.1（[FONT-LICENSE.txt](FONT-LICENSE.txt)）。
- **导出**：`导出 PNG`（1080 宽位图）与 `SVG`（自包含：背景帧位图 + 矢量文字 + 内嵌字体），
  都是当前这一帧，所见即导出。
- **保存**：设计存在 localStorage，预览区标题旁显示「已保存于本地」；刷新、切面板后还在。
- **跟随宿主**：界面框架只用 `--dsw-alias-*` 主题变量，浅色/深色自动适配；海报内部是作品色。

## 目录结构

```
package.json        dsh.bundle.patch + dsh.client(platform=web) + 运行时导出
cordis.patch.yml    只插入插件自己的一行（id: poster-studio）
lib/index.js        宿主半：本插件没有宿主资源，apply 为空
lib/client.js       客户端半：装配 + 工作台 UI + 内联的 WebGL 流体引擎 + 内嵌 Montserrat
locale/zh.json      插件管理页展示用的标题/描述（中文）
locale/en.json      同上（英文）
icon.svg            插件图标（原创图形）
LICENSE             MIT
FONT-LICENSE.txt    Montserrat 的 SIL OFL 1.1 许可证（内嵌字体必须随包提供）
scripts/preflight.mjs   发布前自检（prepack 时自动跑）
scripts/verify-pack.mjs 产物级验证：解包、裸 Node 导入、文件边界
test/manifest.mjs   清单/资源/字体/i18n/默认内容静态校验
test/smoke.mjs      jsdom 渲染测试（槽位、表单、交互、文字层、PNG/SVG 导出、持久化）
```

## 两个槽位

| 槽位 | 形态 | 注册参数 | 作用 |
|---|---|---|---|
| `sidebar.panellist` | list（root） | `id`、`order`、`label` | 左侧栏全局面板图标 |
| `main` | keyed（root） | `key` | 中央面板，`key` 必须等于入口 `id` |

组件收到 shell 传入的 `{ size, active }`（图标）与注册时 `locale` 命名空间绑定好的 `t`（面板）。

## 开发与验证

```bash
npm install
npm test              # 清单校验 + jsdom 渲染测试
npm run preflight     # 发布前自检（npm pack / publish 时由 prepack 自动跑）
npm pack              # 产出 tarball
npm run verify:pack   # 产物级验证：解包 → 裸 Node 导入宿主半 → 检查文件边界与内嵌字体
```

渲染测试需要 react / react-dom / jsdom（`npm install` 已包含）。本机没有浏览器控制能力，
浅色/深色主题下的真实观感、Montserrat 在 DSH 页面里的实际光栅化、GPU 上 shader 的最终动态效果
只做了代码级与真实 Chrome 引擎级校验，没有插件内截图核对。

## 许可证

代码与图标为 MIT（见 [LICENSE](LICENSE)）；内嵌的 Montserrat 字体为 SIL OFL 1.1（见 [FONT-LICENSE.txt](FONT-LICENSE.txt)）。
