/**
 * 海报工坊 —— 清单与资源静态校验。
 *
 * 覆盖发布前最容易出错、又不会被运行时发现的东西：
 *  - package.json 的入口、dsh.bundle.patch、dsh.client、files 列表；
 *  - cordis.patch.yml 的行 id / 包名是否与 package.json 对得上；
 *  - locale 的 meta.title / meta.description；
 *  - icon.svg 是不是合法、独立、体积合规的图标；
 *  - 客户端 bundle 的模块 id、侧栏入口 id、main 槽位 key 三者一致；
 *  - 没有顶层 import / 外部资源 / Harness 客户端包依赖。
 *
 * 运行：node test/manifest.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const read = (name) => fs.readFileSync(path.join(pluginDir, name), 'utf8');

// ------------------------------------------------------------ package.json

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.name, 'dsh-poster-studio', '包名必须是 dsh-poster-studio');
assert.equal(pkg.type, 'module');
assert.equal(typeof pkg.description, 'string');
assert.ok(pkg.description.length >= 30, 'package.json description 要有实际内容');
assert.equal(pkg.exports['.'], './lib/index.js');
assert.equal(pkg.exports['./client'], './lib/client.js');
assert.equal(pkg.exports['./icon'], './icon.svg');
assert.ok(Object.prototype.hasOwnProperty.call(pkg.exports, './locale/*.json'));
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
assert.equal(pkg.dsh?.client?.platform, 'web');
assert.equal(pkg.dsh?.client?.immediately, true);
assert.equal(pkg.icon, './icon.svg');

const shipped = new Set(pkg.files ?? []);
for (const required of ['lib', 'locale', 'cordis.patch.yml', 'icon.svg', 'FONT-LICENSE.txt']) {
  assert.ok(shipped.has(required), `files 必须包含 ${required}`);
}
for (const devOnly of ['parts', 'test']) {
  assert.ok(!shipped.has(devOnly), `开发期目录 ${devOnly} 不应出现在 files 里`);
}

// 内嵌的 Montserrat 是 SIL OFL 字体，必须随包提供许可证。
const fontLicense = read('FONT-LICENSE.txt');
assert.ok(/SIL Open Font License/i.test(fontLicense), 'FONT-LICENSE.txt 必须是 SIL OFL 许可证');
assert.ok(/Montserrat/i.test(fontLicense), '许可证应指明 Montserrat');

// --------------------------------------------------------- cordis.patch.yml

const patch = read('cordis.patch.yml');
assert.ok(/insert:/.test(patch), 'patch 应包含 insert 列表');
assert.ok(/id:\s*poster-studio/.test(patch), 'patch 行 id 必须是 poster-studio');
assert.ok(/name:\s*'dsh-poster-studio'/.test(patch), 'patch 行 name 必须是 dsh-poster-studio');

// ---------------------------------------------------------------- locale

const zh = JSON.parse(read('locale/zh.json'));
const en = JSON.parse(read('locale/en.json'));
for (const [name, dict] of [['zh', zh], ['en', en]]) {
  assert.equal(typeof dict.meta?.title, 'string', `${name}.meta.title 必须是字符串`);
  assert.ok(dict.meta.title.length > 1, `${name}.meta.title 不能为空`);
  assert.equal(typeof dict.meta?.description, 'string', `${name}.meta.description 必须是字符串`);
  assert.ok(dict.meta.description.length >= 20, `${name}.meta.description 要描述实际能力`);
}
assert.notEqual(zh.meta.title, en.meta.title, '中英标题应各自本地化');
assert.equal(zh.meta.title, '海报工坊', '插件展示名应为「海报工坊」');
assert.equal(en.meta.title, 'Poster workshop', '英文展示名应为 Poster workshop');
assert.ok(zh.meta.description.includes('海报工坊'), '中文描述应使用插件名「海报工坊」');

// ------------------------------------------------------------------ 图标

const icon = read('icon.svg');
assert.ok(icon.startsWith('<svg') || icon.startsWith('<?xml'), 'icon.svg 必须是 SVG');
assert.ok(/viewBox=/.test(icon), 'icon.svg 需要 viewBox');
assert.ok(!/<image\b/.test(icon), 'icon.svg 不应内嵌位图');
assert.ok(!/xlink:href|href\s*=\s*['"]https?:/i.test(icon), 'icon.svg 不应引用外部资源');
assert.ok(Buffer.byteLength(icon, 'utf8') <= 256 * 1024, 'icon.svg 不得超过 256 KiB');

// -------------------------------------------------------------- 宿主半

const host = read('lib/index.js');
assert.ok(/export\s+function\s+apply\s*\(/.test(host), '宿主半应导出 apply(ctx, config)');

// -------------------------------------------------------------- 客户端半

const client = read('lib/client.js');

const moduleId = client.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
assert.ok(moduleId !== null, '客户端半应通过 __ModuleLoader__ 注册');
assert.equal(moduleId[1], pkg.name, '客户端模块 id 必须等于包名');

assert.ok(/inject:\s*\[\s*'slots'\s*,\s*'locale'\s*\]/.test(client), '客户端应只依赖 slots / locale');
assert.ok(/name:\s*'sidebar\.panellist'/.test(client), '应注册 sidebar.panellist');
assert.ok(/name:\s*'main'/.test(client), '应注册 main');

const entryId = client.match(/const ENTRY_ID = '([^']+)'/);
assert.ok(entryId !== null, '应声明 ENTRY_ID');
assert.equal(entryId[1], 'poster-studio', 'ENTRY_ID 必须是 poster-studio');
assert.ok(
  new RegExp(`id:\\s*ENTRY_ID,\\s*order:`).test(client),
  '左侧栏入口应使用 ENTRY_ID 作为 id',
);
assert.ok(
  new RegExp(`key:\\s*ENTRY_ID`).test(client),
  'main 槽位 key 应使用 ENTRY_ID，否则点左侧栏图标会抛错',
);
assert.ok(/const NS = 'poster-studio'/.test(client), 'locale 命名空间应为 poster-studio');
assert.ok(/locale:\s*NS/.test(client), 'main 注册应绑定 locale 命名空间');

// 默认标题按视频拆成两行字段：Everything / is a plugin（合起来仍是 Everything is a plugin）。
assert.ok(/title1: 'Everything'/.test(client), '默认主标题第一行必须是 Everything');
assert.ok(/title2: 'is a plugin'/.test(client), '默认主标题第二行必须是 is a plugin');
assert.ok(/eyebrow: 'DEEPSEEK HARNESS — OPEN SOURCE'/.test(client), '默认眉标应取自视频示例');
assert.ok(/subtitle: '一切皆插件'/.test(client), '默认中文副标题应为「一切皆插件」');
assert.ok(/footer: 'DEEPSEEK · HARNESS'/.test(client), '默认页脚应存在');
assert.ok(/issue: '第 01 期'/.test(client), '默认期号应存在');
assert.ok(!/^\s*import\s/m.test(client), '客户端 bundle 不应有顶层 import');
assert.ok(!/require\(['"]@deepseek-ai\//.test(client), '不应 require Harness 客户端包');
assert.ok(!/@import|url\(\s*['"]?https?:/i.test(client), '不应加载外部样式或资源');

// 流体引擎必须真的内联进来（而不是占位实现）。
assert.ok(/uniform\s+vec3\s+u_color0/.test(client), '客户端内应内联流体 shader 引擎');
assert.ok(/gl\.drawArrays/.test(client), '引擎应真的发起绘制调用');
assert.ok(/webgl2/.test(client) && /'webgl'/.test(client), '引擎应同时尝试 WebGL2 与 WebGL1');

// 官网同款字体：Montserrat 以 data URI 内嵌，不依赖外部 CDN。
assert.ok(/@font-face\{[^}]*font-family:"Montserrat"/.test(client), '应内嵌 Montserrat @font-face');
assert.ok((client.match(/data:font\/woff2;base64,/g) ?? []).length >= 2, '应内嵌 400 / 500 两个字重');
assert.ok(/\bMontserrat\b/.test(client.match(/const FONT_STACK =[\s\S]*?;/)?.[0] ?? ''), 'FONT_STACK 应优先 Montserrat');
assert.ok(!/url\(['"]?https?:/.test(client), '字体不應走外部 URL');

// 四套配色与默认值（与视频里的「午夜 / 钴蓝 / 余烬 / 纸白」对应）。
assert.ok(/id: 'midnight'/.test(client) && /id: 'cobalt'/.test(client), '应内置午夜 / 钴蓝配色');
assert.ok(/id: 'ember'/.test(client) && /id: 'paper'/.test(client), '应内置余烬 / 纸白配色');
assert.ok(/#0561b6/.test(client) && /#70defb/.test(client), '钴蓝配色应包含蓝色系色值');
assert.ok(/#efe9df/.test(client), '纸白配色应包含纸白底色');
assert.ok(/paletteId: 'cobalt'/.test(client), '默认配色应为钴蓝');

// 画幅选项与默认画幅（与视频一致）。
assert.ok(/id: '4:5', w: 1080, h: 1350/.test(client), '应支持 4:5 画幅');
assert.ok(/id: '1:1', w: 1080, h: 1080/.test(client), '应支持 1:1 画幅');
assert.ok(/id: '3:4', w: 1080, h: 1440/.test(client), '应支持 3:4 画幅');
assert.ok(/id: '9:16', w: 1080, h: 1920/.test(client), '应支持 9:16 画幅');
assert.ok(/sizeId: '4:5'/.test(client), '默认画幅应为 4:5');

// 样式与导出能力。
assert.ok(/moduleGraphic: false/.test(client), '模块图形默认关闭');
assert.ok(/flowSpeed: 46/.test(client), '默认流动速度应为 46');
assert.ok(/function buildPosterSvg\(/.test(client), '应支持导出 SVG');
assert.ok(/image\/svg\+xml/.test(client), 'SVG 导出应使用正确的 MIME');
assert.ok(/toDataURL\('image\/png'\)/.test(client), '应支持导出 PNG');
assert.ok(/localStorage/.test(client), '设计应持久化到 localStorage');

// ------------------------------------------------------------ 发布的文件

const mustExist = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json'];
for (const relative of mustExist) {
  assert.ok(fs.existsSync(path.join(pluginDir, relative)), `缺少运行时文件 ${relative}`);
}

console.log('ok - dsh-poster-studio manifest check passed');
