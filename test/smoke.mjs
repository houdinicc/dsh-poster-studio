/**
 * 海报工坊 —— 客户端半的离线渲染测试。
 *
 * 客户端 bundle 是 `window.__ModuleLoader__.load({ id, factory })` 形式的
 * 自注册脚本，浏览器之外跑不了。这里用 jsdom + 真实 React 复现宿主环境：
 *
 *   1. 装好窗口、DOM，以及一个「会记录调用」的 canvas 2D 上下文垫片
 *      （jsdom 本身没有 canvas，不装垫片的话文字层与导出路径一行都跑不到）；
 *   2. import 客户端 bundle，捕获它登记的定义；
 *   3. 用假 ctx 调 apply()，检查它往哪些 slot 注册了什么；
 *   4. 真实渲染面板、真实输入/点击，断言文案、样式、画布尺寸、导出文件名与
 *      SVG 内容、localStorage 持久化。
 *
 * 依赖（仅开发期）：react / react-dom / jsdom。在插件目录 `npm install` 后即可运行。
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
/**
 * 开发依赖解析：优先本仓库自己的 node_modules（`npm install` 之后），
 * 其次本机兄弟目录（作者开发机上的临时依赖目录，发布后仓库里走前一条）。
 */
const devBaseCandidates = [
  path.join(pluginDir, 'package.json'),
  path.join(pluginDir, '..', 'dsh-todos-dev', 'package.json'),
];

function loadDevModule(specifier) {
  for (const base of devBaseCandidates) {
    try {
      return createRequire(base)(specifier);
    } catch (error) {
      // 换下一个候选目录
    }
  }
  return null;
}

const jsdomModule = loadDevModule('jsdom');
if (!jsdomModule) {
  console.error('缺少开发依赖 jsdom。请在插件目录运行：npm install');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = jsdomModule;

// ------------------------------------------------------------- 1. 宿主环境

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true, virtualConsole },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.localStorage = dom.window.localStorage;

// ---------------------------------------------------- 1b. canvas 2D 记录垫片

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const canvasContexts = new WeakMap();

function recordingContext(canvas) {
  const calls = { fillText: [], fillRect: [], strokeRect: [], clearRect: [], drawImage: [], gradients: 0 };
  const ctx = {
    canvas,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    clearRect(x, y, w, h) { calls.clearRect.push([x, y, w, h]); },
    fillRect(x, y, w, h) { calls.fillRect.push([x, y, w, h]); },
    strokeRect(x, y, w, h) { calls.strokeRect.push([x, y, w, h]); },
    fillText(text, x, y) {
      calls.fillText.push({
        text: String(text),
        x,
        y,
        font: this.font,
        fillStyle: this.fillStyle,
        textAlign: this.textAlign,
        letterSpacing: this.letterSpacing,
        globalAlpha: this.globalAlpha,
      });
    },
    measureText(text) {
      // 近似等宽：每字符 20px，足以让折行/缩字号逻辑真实执行。
      return { width: String(text).length * 20 };
    },
    createLinearGradient() { calls.gradients += 1; return { addColorStop() {} }; },
    createRadialGradient() { calls.gradients += 1; return { addColorStop() {} }; },
    drawImage(...args) { calls.drawImage.push(args); },
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    arc() {},
    fill() {},
    stroke() {},
  };
  ctx._calls = calls;
  return ctx;
}

dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
  if (type !== '2d') return null; // WebGL 一律不可用，正好覆盖 CSS 兜底路径
  let ctx = canvasContexts.get(this);
  if (!ctx) {
    ctx = recordingContext(this);
    canvasContexts.set(this, ctx);
  }
  return ctx;
};
dom.window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
  return PNG_DATA_URL;
};

const downloaded = [];
dom.window.HTMLAnchorElement.prototype.click = function click() {
  downloaded.push({ href: this.href, download: this.download });
};

const createdBlobs = [];
const originalCreateObjectURL = globalThis.URL.createObjectURL;
globalThis.URL.createObjectURL = (blob) => {
  createdBlobs.push(blob);
  return 'blob:pst-test';
};
globalThis.URL.revokeObjectURL = () => {};

// ------------------------------------------------------------ 2. 载入 bundle

const registered = [];
dom.window.__ModuleLoader__ = { load: (definition) => registered.push(definition) };

// React / ReactDOM 必须在 window、document 等全局安装**之后**再加载：
// react-dom 在模块初始化时会读 window 来判断是否在浏览器环境，加载过早会让事件系统失效。
const reactModule = loadDevModule('react');
const reactDomModule = loadDevModule('react-dom/client');
const jsxRuntimeModule = loadDevModule('react/jsx-runtime');
if (!reactModule || !reactDomModule) {
  console.error('缺少开发依赖（react / react-dom）。请在插件目录运行：npm install');
  process.exit(2);
}
const React = reactModule;
const ReactDOMClient = reactDomModule;
const { act } = React;
const h = React.createElement;

await import(pathToFileURL(path.join(pluginDir, 'lib', 'client.js')).href);

assert.equal(registered.length, 1, '客户端 bundle 应恰好登记一个模块定义');
const definition = registered[0];
assert.equal(definition.id, 'dsh-poster-studio', '模块 id 必须等于包名');
assert.equal(typeof definition.factory, 'function', 'factory 必须是函数');

// ------------------------------------------------------- 3. 收集 slot 注册

const dictionaries = new Map();
const slotRegistrations = [];
const effects = [];

function translate(namespace) {
  return (key, params) => {
    const dicts = dictionaries.get(namespace) ?? {};
    const template = dicts.zh?.[key] ?? dicts.en?.[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
  };
}

const fakeCtx = {
  effect(fn, label) {
    effects.push({ label, dispose: fn() });
    return () => {};
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.set(namespace, dicts);
      return () => {};
    },
    bind: translate,
  },
  slots: {
    inject(owner, callback) {
      callback();
      return () => {};
    },
    register(options, Component) {
      slotRegistrations.push({ options, Component });
      return () => {};
    },
  },
};

const moduleExports = definition.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return jsxRuntimeModule;
  throw new Error(`客户端 bundle 不应 require ${specifier}`);
});

assert.deepEqual(moduleExports.inject, ['slots', 'locale'], '客户端服务依赖应只有 slots / locale');
assert.equal(typeof moduleExports.apply, 'function');
moduleExports.apply(fakeCtx);

// ------------------------------------------------------------ 4. 断言装配

const bySlot = new Map(slotRegistrations.map((r) => [r.options.name, r]));
const panellist = bySlot.get('sidebar.panellist');
const main = bySlot.get('main');

assert.ok(panellist !== undefined, '应注册到 sidebar.panellist');
assert.ok(main !== undefined, '应注册到 main');
assert.equal(panellist.options.id, 'poster-studio', '侧边栏条目 id 必须是 poster-studio');
assert.equal(main.options.key, 'poster-studio', 'main 的 key 必须与侧边栏 id 相同，否则点击会抛错');
assert.equal(panellist.options.order, 20);
assert.equal(typeof panellist.options.label, 'function', 'label 应为函数，以便跟随语言切换');
assert.equal(panellist.options.label(), '海报工坊');
assert.equal(main.options.locale, 'poster-studio');
assert.equal(typeof panellist.Component, 'function', '侧边栏应提供字形组件');
assert.equal(typeof main.Component, 'function', 'main 应提供面板组件');

const styleTag = document.querySelector('style[data-plugin-css="dsh-poster-studio"]');
assert.ok(styleTag !== null, '应注入带 data-plugin-css 的样式标签');
assert.ok(styleTag.textContent.includes('--dsw-alias-'), '样式必须走主题 token');
assert.ok(styleTag.textContent.includes('@font-face'), '样式里应内嵌 Montserrat 字体面');
assert.ok(!/@import|url\(\s*['"]?https?:/i.test(styleTag.textContent), '样式不应加载外部资源');

// 主题 token 护栏：引用不存在的 token 不会报错，只会让那条声明静默失效。
const KNOWN_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]);
const clientSource = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8');
const referencedTokens = [
  ...new Set([...clientSource.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1])),
].sort();
assert.deepEqual(
  referencedTokens.filter((token) => !KNOWN_TOKENS.has(token)),
  [],
  '引用了不存在的主题 token',
);

// i18n 护栏：代码里 t('key') 引用的键必须在 zh / en 两个字典里都存在。
const zhBlock = clientSource.slice(
  clientSource.indexOf('    const zh = {'),
  clientSource.indexOf('    const en = {'),
);
const enBlock = clientSource.slice(
  clientSource.indexOf('    const en = {'),
  clientSource.indexOf('    const CSS = `'),
);
const zhKeys = new Set([...zhBlock.matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
const enKeys = new Set([...enBlock.matchAll(/^\s+'([\w.]+)':/gm)].map((m) => m[1]));
const literalKeys = new Set(
  [...clientSource.matchAll(/(?<![\w.$])t\(['"]([\w.]+)['"]/g)].map((m) => m[1]),
);
assert.deepEqual([...literalKeys].filter((key) => !zhKeys.has(key)), [], 'zh 缺键');
assert.deepEqual([...literalKeys].filter((key) => !enKeys.has(key)), [], 'en 缺键');
assert.deepEqual([...zhKeys].filter((key) => !enKeys.has(key)), [], '中英字典键必须对齐');
assert.deepEqual([...enKeys].filter((key) => !zhKeys.has(key)), [], '中英字典键必须对齐');

// ------------------------------------------------------- 5. 渲染与交互

const { createRoot } = ReactDOMClient;
const container = document.getElementById('root');
const root = createRoot(container);
const t = translate('poster-studio');

function mountPanel() {
  return act(async () => {
    root.render(h(main.Component, { t }));
  });
}
function unmountPanel() {
  return act(async () => {
    root.render(null);
  });
}
function click(element) {
  return act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
}
function setValue(element, value, prototype) {
  return act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor.set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
function fgCanvas() { return container.querySelector('canvas.pst-fg'); }
function fgCalls() { return canvasContexts.get(fgCanvas())._calls; }

await mountPanel();

assert.ok(container.querySelector('.pst-root') !== null, '面板应渲染出 .pst-root');
assert.equal(container.querySelector('.pst-title').textContent, '海报工坊');
assert.equal(container.querySelector('.pst-subtitle').textContent, '实时流体背景，编辑文案，导出海报。');
assert.equal(container.querySelector('.pst-preview-title').textContent, 'Everything is a plugin');

const sectionTitles = [...container.querySelectorAll('.pst-section-title')].map((n) => n.textContent);
assert.deepEqual(sectionTitles.slice(0, 2), ['文案', '样式'], '应有两段表单小节');
assert.ok(sectionTitles.includes('背景'), '样式段里应有「背景」小节');

// 文案字段：标签与默认值
const labels = [...container.querySelectorAll('.pst-label')].map((n) => n.textContent);
for (const expected of ['眉标', '主标题 · 第一行', '主标题 · 第二行', '中文副标题', '说明文案', '页脚', '期号']) {
  assert.ok(labels.includes(expected), `缺少字段标签：${expected}`);
}
const textInputs = [...container.querySelectorAll('input.pst-input')];
const textValues = textInputs.map((n) => n.value);
assert.deepEqual(textValues, [
  'DEEPSEEK HARNESS — OPEN SOURCE',
  'Everything',
  'is a plugin',
  '一切皆插件',
  'DEEPSEEK · HARNESS',
  '第 01 期',
]);
const textarea = container.querySelector('textarea.pst-input');
assert.ok(textarea.value.includes('工具、技能、界面'));
assert.ok(textarea.value.includes('\n'), '说明文案默认应为两行');

// 画幅：4 个卡片，默认 4:5
const sizeButtons = [...container.querySelectorAll('.pst-card:not(.pst-preset)')];
assert.equal(sizeButtons.length, 4, '画幅应有 4 个选项');
assert.deepEqual(sizeButtons.map((n) => n.querySelector('.pst-card-title').textContent), ['4:5', '1:1', '3:4', '9:16']);
assert.deepEqual(sizeButtons.map((n) => n.querySelector('.pst-card-sub').textContent), [
  '1080 × 1350',
  '1080 × 1080',
  '1080 × 1440',
  '1080 × 1920',
]);
assert.equal(sizeButtons[0].getAttribute('aria-pressed'), 'true', '默认画幅应为 4:5');
assert.equal(fgCanvas().getAttribute('width'), '1080');
assert.equal(fgCanvas().getAttribute('height'), '1350');

// 对齐 / 配色 / 模块图形 / 流动速度
const alignButtons = [...container.querySelectorAll('.pst-seg-btn')];
assert.deepEqual(alignButtons.map((n) => n.textContent), ['左对齐', '居中']);
assert.equal(alignButtons[0].getAttribute('aria-pressed'), 'true');

const presetButtons = [...container.querySelectorAll('.pst-preset')];
assert.equal(presetButtons.length, 4, '配色应有 4 套预设');
assert.deepEqual(presetButtons.map((n) => n.querySelector('.pst-preset-name').textContent), ['午夜', '钴蓝', '余烬', '纸白']);
assert.equal(presetButtons[1].getAttribute('aria-pressed'), 'true', '默认配色应为钴蓝');

const switchButton = container.querySelector('.pst-switch');
assert.equal(switchButton.getAttribute('role'), 'switch');
assert.equal(switchButton.getAttribute('aria-checked'), 'false');

const rangeInput = container.querySelector('.pst-range');
assert.equal(rangeInput.value, '46');
assert.equal(container.querySelector('.pst-range-value').textContent, '46');

assert.equal(container.querySelector('.pst-actions .pst-btn').textContent, '恢复默认');
assert.equal(container.querySelector('.pst-btn-primary').textContent, '导出 PNG');
assert.equal(container.querySelector('.pst-topbar .pst-btn').textContent, 'SVG');
assert.equal(container.querySelector('.pst-live').textContent, '实时');
assert.equal(container.querySelector('.pst-saved').textContent, '已保存于本地');

// 文字层真的画了：眉标大写、标题 500 字重 Montserrat、副标题、说明、页脚
const firstPaint = fgCalls().fillText;
const texts = firstPaint.map((call) => call.text);
assert.ok(texts.includes('DEEPSEEK HARNESS — OPEN SOURCE'), '眉标应大写后绘制');
assert.ok(texts.includes('Everything'), '标题第一行应绘制');
assert.ok(texts.includes('is a plugin'), '标题第二行应绘制');
assert.ok(texts.includes('一切皆插件'), '副标题应绘制');
assert.ok(texts.some((value) => value.includes('工具、技能、界面')), '说明文案应绘制');
assert.ok(texts.includes('DEEPSEEK · HARNESS'), '左页脚应绘制');
assert.ok(texts.includes('第 01 期'), '期号应绘制');
const titleCall = firstPaint.find((call) => call.text === 'Everything');
assert.match(titleCall.font, /^500 \d+px "Montserrat"/, '标题应为 Montserrat 500');
assert.equal(titleCall.fillStyle, 'rgba(255,255,255,1)', '钴蓝配色标题应为纯白');

// 改标题：预览标题与文字层一起更新
const title2Input = textInputs[2];
await setValue(title2Input, 'can be created', dom.window.HTMLInputElement.prototype);
assert.equal(container.querySelector('.pst-preview-title').textContent, 'Everything can be created');
await act(async () => {});
assert.ok(
  fgCalls().fillText.some((call) => call.text === 'can be created'),
  '改标题后文字层应重画',
);

// 画幅切到 1:1：画布尺寸跟着变
await click(sizeButtons[1]);
assert.equal(fgCanvas().getAttribute('width'), '1080');
assert.equal(fgCanvas().getAttribute('height'), '1080');
assert.equal(sizeButtons[1].getAttribute('aria-pressed'), 'true');
assert.equal(sizeButtons[0].getAttribute('aria-pressed'), 'false');

// 居中：文字层应以 textAlign=center 绘制
await click(alignButtons[1]);
const centerPaint = fgCalls().fillText.filter((call) => call.textAlign === 'center');
assert.ok(centerPaint.length > 0, '居中时文字应以 center 对齐绘制');

// 配色切到纸白：文字层墨色应为深色
await click(presetButtons[3]);
const paperPaint = fgCalls().fillText.filter((call) => call.text === 'Everything').at(-1);
assert.match(paperPaint.fillStyle, /^rgba\(25,21,18,/, '纸白配色应改用深色墨');

// 模块图形开关：打开后文字层应出现描边方块
await click(switchButton);
assert.equal(switchButton.getAttribute('aria-checked'), 'true');
assert.ok(fgCalls().strokeRect.length >= 3, '模块图形应在海报上画出描边方块');

// 流动速度：滑杆更新数值显示
await setValue(rangeInput, '80', dom.window.HTMLInputElement.prototype);
assert.equal(container.querySelector('.pst-range-value').textContent, '80');

// 恢复默认：所有字段回到默认值
await click(container.querySelector('.pst-actions .pst-btn'));
assert.equal(container.querySelector('.pst-preview-title').textContent, 'Everything is a plugin');
assert.equal(container.querySelector('.pst-range-value').textContent, '46');
assert.equal(container.querySelector('input.pst-input').value, 'DEEPSEEK HARNESS — OPEN SOURCE');

// 导出 PNG：下载一个 poster-*.png
await click(container.querySelector('.pst-btn-primary'));
assert.equal(downloaded.length, 1, '导出 PNG 应触发一次下载');
assert.match(downloaded[0].download, /^poster-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
assert.equal(downloaded[0].href, PNG_DATA_URL);

// 导出 SVG：下载一个自包含的 poster-*.svg
await click(container.querySelector('.pst-topbar .pst-btn'));
assert.equal(downloaded.length, 2, '导出 SVG 应再触发一次下载');
assert.match(downloaded[1].download, /^poster-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.svg$/);
assert.equal(createdBlobs.length, 1, 'SVG 应以 Blob 下载');
const svgText = await createdBlobs[0].text();
assert.ok(svgText.startsWith('<?xml'), 'SVG 应以 XML 声明开头');
assert.ok(svgText.includes('<svg'), 'SVG 根元素应存在');
assert.ok(svgText.includes('width="1080"') && svgText.includes('height="1350"'), 'SVG 尺寸应跟随默认画幅');
assert.ok(svgText.includes('@font-face') && svgText.includes('Montserrat'), 'SVG 应内嵌 Montserrat 字体');
assert.ok(svgText.includes('>Everything<') && svgText.includes('>is a plugin<'), 'SVG 应包含标题文字');
assert.ok(svgText.includes('text-anchor="start"'), '默认左对齐应使用 start 锚点');
assert.ok(svgText.includes('<image'), 'SVG 背景应以位图帧嵌入');

// 持久化：设计写入 localStorage，重挂载后恢复
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
const stored = JSON.parse(dom.window.localStorage.getItem('dsh-poster-studio.design.v2'));
assert.equal(stored.title2, 'is a plugin');
assert.equal(stored.sizeId, '4:5');
assert.equal(dom.window.localStorage.getItem('dsh-poster-studio.design.v1'), null, '不应写旧版键');

await unmountPanel();
await mountPanel();
assert.equal(container.querySelector('.pst-preview-title').textContent, 'Everything is a plugin');

// 侧栏字形：一个 svg，尺寸跟随 shell 传入的 size
let glyph = null;
await act(async () => {
  glyph = panellist.Component({ size: 18, active: true });
});
assert.ok(glyph !== null, '侧栏图标应可渲染');
assert.equal(glyph.type, 'svg');
assert.equal(glyph.props.width, 18, '图标尺寸应使用 shell 传入的 size');

// ------------------------------------------------------- 6. 清理与收尾

await unmountPanel();
for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose();
}
assert.equal(
  document.querySelector('style[data-plugin-css="dsh-poster-studio"]'),
  null,
  '插件卸载后样式标签应被移除',
);

// 还原被垫片接管过的全局对象，避免影响同进程里其它测试。
globalThis.URL.createObjectURL = originalCreateObjectURL;

console.log('ok - dsh-poster-studio client smoke test passed');
