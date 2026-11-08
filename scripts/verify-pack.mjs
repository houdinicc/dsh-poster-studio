/**
 * 海报工坊 —— 产物级验证：不看工作区，只看「别人真正会装到的东西」。
 *
 * `preflight.mjs` 校验的是**源码与分发契约**；本脚本校验的是**打包产物本身**：
 * 解压 → 检查文件边界 → 裸 Node 导入宿主半 → 检查客户端 bundle 自包含性。
 *
 * 这一步能抓到的、preflight 抓不到的问题：
 *   - `files` 漏了某个运行时文件（图标、locale、patch）导致装完不显示 / 不激活；
 *   - 产物里混进了 test/scripts/parts（开发期文件不该进别人的 node_modules）；
 *   - 宿主半偷偷 import 了 `@deepseek-ai/*`，在没有 DSH 的机器上一 import 就抛错；
 *   - 内嵌字体在打包过程中被截断（base64 解出来不再是 wOF2）。
 *
 * 用法：
 *   node scripts/verify-pack.mjs                 # 用与当前版本一致的 .tgz
 *   node scripts/verify-pack.mjs <路径或 URL>     # 指定 tarball
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const problems = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === undefined ? '' : `\n        → ${detail}`}`);
  if (!ok) problems.push(name);
};

// ------------------------------------------------------------ 1. 取 tarball

const localManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function resolveTarget() {
  const arg = process.argv[2];
  if (arg !== undefined) {
    if (/^https?:\/\//.test(arg)) {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-poster-dl-')), 'pkg.tgz');
      const response = await fetch(arg);
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${arg}`);
      fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
      return { file: tmp, label: arg, downloaded: true };
    }
    return { file: path.resolve(arg), label: path.resolve(arg), downloaded: false };
  }

  // 默认找**与当前 package.json 版本一致**的那份，别静默验旧包。
  const expected = `${localManifest.name}-${localManifest.version}.tgz`;
  const exact = [path.join(root, expected), path.join(root, 'dist', expected)].find((p) => fs.existsSync(p));
  if (exact !== undefined) return { file: exact, label: exact, downloaded: false };

  const dir = path.join(root, 'dist');
  const inDist = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')) : [];
  const inRoot = fs.readdirSync(root).filter((f) => f.endsWith('.tgz'));
  const all = [...inRoot, ...inDist];
  if (all.length === 0) {
    throw new Error(`没找到 ${expected}，${root} 和 dist/ 里也没有任何 .tgz。先跑 \`npm pack\`。`);
  }
  throw new Error(
    `没找到与当前清单版本一致的 ${expected}，但存在其它 tarball：${all.join('、')}。\n`
    + '  先跑 `npm pack` 重新打包，或显式把 tarball 路径作为参数传进来。',
  );
}

const target = await resolveTarget();
console.log(`待验证产物：${target.label}`);
console.log(`大小：${fs.statSync(target.file).size} 字节\n`);

// ---------------------------------------------------------------- 2. 解压

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-poster-verify-'));
const extractDir = path.join(workdir, 'x');
fs.mkdirSync(extractDir, { recursive: true });
execFileSync('tar', ['-xzf', target.file, '-C', extractDir], { stdio: 'pipe' });
const pkgDir = path.join(extractDir, 'package');
if (!fs.existsSync(pkgDir)) throw new Error('tarball 里没有 package/ 目录');

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// --------------------------------------------------- 3. 清单与文件完整性

check(
  `产物版本与本地清单一致（${manifest.name}@${manifest.version}）`,
  manifest.version === localManifest.version && manifest.name === localManifest.name,
  `本地清单是 ${localManifest.name}@${localManifest.version}；验的可能不是刚打包的那份`,
);

const clientRel = manifest.exports?.['./client'];
const clientPath = typeof clientRel === 'string' ? clientRel : clientRel?.default;
const mainRel = manifest.exports?.['.'] ?? manifest.main;
const mainPath = typeof mainRel === 'string' ? mainRel : mainRel?.default;

const clientSource = fs.readFileSync(path.join(pkgDir, clientPath), 'utf8');
const bundleId = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"`]([^'"`]+)['"`]/.exec(clientSource)?.[1];
check(
  `客户端 bundle 的 id 与包名一致（${bundleId} === ${manifest.name}）`,
  bundleId === manifest.name,
  'loader 要求两者完全相同，否则 DSH 加载该插件时会失败',
);

const required = [
  mainPath,
  clientPath,
  manifest.icon,
  manifest.dsh?.bundle?.patch,
  'locale/en.json',
  'locale/zh.json',
  'LICENSE',
  'README.md',
  'FONT-LICENSE.txt',
];
for (const rel of required) {
  check(`产物含 ${typeof rel === 'string' ? rel : JSON.stringify(rel)}`, typeof rel === 'string' && fs.existsSync(path.join(pkgDir, rel)));
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const shipped = walk(pkgDir).map((abs) => path.relative(pkgDir, abs).split(path.sep).join('/'));

for (const forbidden of ['test/', 'scripts/', 'parts/', 'dev/', 'dist/', '.git/', 'node_modules/']) {
  check(`产物不含 ${forbidden}`, !shipped.some((rel) => rel.startsWith(forbidden)));
}
check(
  `产物内无本机绝对路径 / 令牌`,
  walk(pkgDir).every((abs) => {
    if (!/\.(mjs|js|json|yml|yaml|md|txt|svg)$/i.test(abs)) return true;
    const text = fs.readFileSync(abs, 'utf8');
    return !/(^|[\s"'(])\/(Users|home)\/[A-Za-z0-9._-]+\//.test(text)
      && !/(npm_|gh[pousr]_)[A-Za-z0-9]{20,}/.test(text);
  }),
);

// 图标与 patch 行
const icon = fs.readFileSync(path.join(pkgDir, manifest.icon), 'utf8');
check('图标是 SVG 且带 viewBox', /<svg[\s\S]*viewBox=/.test(icon));
check('图标小于 256 KiB', Buffer.byteLength(icon, 'utf8') <= 256 * 1024);

const patchText = fs.readFileSync(path.join(pkgDir, manifest.dsh.bundle.patch), 'utf8');
check(
  'cordis.patch.yml 插入了插件自己的行',
  /id:\s*poster-studio/.test(patchText) && patchText.includes(manifest.name),
  patchText.trim().slice(0, 120),
);

// ------------------------------------- 4. 客户端 bundle 自包含性

check('客户端 bundle 是 __ModuleLoader__ 自注册', clientSource.includes('__ModuleLoader__.load('));
check('客户端 bundle 没有顶层 import', !/^\s*import\s/m.test(clientSource));
check('客户端 bundle 不 require @deepseek-ai/*', !/require\(['"]@deepseek-ai\//.test(clientSource));
check('客户端 bundle 内联了流体 shader 引擎', /createFluidRenderer/.test(clientSource) && /gl\.drawArrays/.test(clientSource));
check('客户端 bundle 支持 SVG 导出', /buildPosterSvg/.test(clientSource) && /image\/svg\+xml/.test(clientSource));
check('客户端 bundle 把设计存 localStorage', /localStorage/.test(clientSource));

const fontMatches = [...clientSource.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)];
check(`内嵌字体数量 ≥ 2（实际 ${fontMatches.length}）`, fontMatches.length >= 2);
check(
  '每个内嵌字体都是完整 WOFF2（前 4 字节 wOF2）',
  fontMatches.every((match) => Buffer.from(match[1], 'base64').subarray(0, 4).toString('latin1') === 'wOF2'),
);

let parses = false;
try {
  execFileSync(process.execPath, ['--check', path.join(pkgDir, clientPath)], { stdio: 'pipe' });
  parses = true;
} catch (error) {
  parses = false;
}
check('产物里的客户端 bundle 语法可解析（node --check）', parses);

// ------------------------------- 5. 导入宿主半（模拟「没有 DSH 的机器」）

let moduleExports = null;
try {
  moduleExports = await import(pathToFileURL(path.join(pkgDir, mainPath)).href);
  check('宿主半可以被纯 Node 直接 import（说明没偷偷 import @deepseek-ai/* 等运行时包）', true);
} catch (error) {
  check('宿主半可以被纯 Node 直接 import', false, String(error?.message ?? error));
}

if (moduleExports !== null) {
  check('导入后导出 apply 函数', typeof moduleExports.apply === 'function');
  try {
    // 本插件的宿主半是空 apply：只要不抛错即可。
    moduleExports.apply({}, {});
    check('apply(ctx) 能正常执行（无宿主资源）', true);
  } catch (error) {
    check('apply(ctx) 能正常执行', false, String(error?.message ?? error));
  }
}

// ---------------------------------------------------------------- 报告

fs.rmSync(workdir, { recursive: true, force: true });
if (!target.downloaded && !process.argv[2]) {
  console.log('\n（只验证了本地 .tgz；要验证注册表上的，传 tarball URL：');
  console.log(`   node scripts/verify-pack.mjs https://registry.npmjs.org/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz ）`);
}

if (problems.length > 0) {
  console.error(`\n产物验证未通过：${problems.length} 项`);
  process.exit(1);
}
console.log('\n产物验证通过。');
