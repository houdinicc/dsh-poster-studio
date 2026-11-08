/**
 * 海报工坊（dsh-poster-studio）—— 宿主半入口。
 *
 * 这个插件的界面完全由客户端半渲染：`lib/client.js` 在浏览器里注册
 * `sidebar.panellist`（左侧栏图标入口）与 `main`（中央主面板）两个槽位。
 * 因此宿主半不需要注册任何服务、路由或工具，`apply` 保持为空即可。
 *
 * @module dsh-poster-studio
 */

/** Cordis 插件入口；本插件没有宿主侧资源。 */
export function apply() {}
