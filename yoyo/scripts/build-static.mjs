/**
 * 把浏览器端代码合成一个纯静态可部署目录 dist/static/。
 *
 * 关键约束:**目录层级必须与仓库根一致**。
 * public/js/ui.js 里写的是 `import { parseMidi } from '../../lib/midi.mjs'`,
 * 这个相对路径是从 `public/js/` 往上两级。所以在 dist/static/ 里也必须保持
 * `dist/static/public/js/ui.js` 与 `dist/static/lib/midi.mjs` 的层级关系,
 * 少一层相对路径就全断,页面直接白屏。
 *
 * 零依赖,只用 node:内置模块。
 */
import { cp, mkdir, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'static');

/** 要拷进静态产物的顶层条目(相对仓库根) */
const COPY = ['public', 'lib'];

/** 静态产物里不该有的东西 */
const EXCLUDE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function isExcluded(src) {
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base)) return true;
  if (base.endsWith('.map')) return true;
  if (/\.(test|spec)\.(mjs|js)$/.test(base)) return true;
  return false;
}

/**
 * 源码里 `public/js/*.js` 写的是 `../../lib/xxx.mjs` —— 从 public/js/ 往上两级
 * 正好是仓库根的 lib/。
 *
 * 但静态部署时我们想让 `dist/static/` **直接就是站点根**(用户传上去就能开,
 * 不用再往下进一层 public/)。在扁平布局下 js/ 与 lib/ 是兄弟目录,正确的相对
 * 路径是 `../lib/`。所以构建时必须重写这一段,否则整页白屏。
 *
 * 只重写指向 lib/ 的引用,其它相对路径不动 —— 避免误伤未来的其它资源。
 */
const LIB_REF_RE = /(\.\.\/)+lib\//g;

async function rewriteLibRefs(dir) {
  let rewritten = 0;
  for (const f of await walk(dir)) {
    if (!/\.(js|mjs|html)$/.test(f)) continue;
    const text = await readFile(f, 'utf8');
    if (!text.includes('lib/')) continue;
    const next = text.replace(LIB_REF_RE, '../lib/');
    if (next !== text) {
      await writeFile(f, next, 'utf8');
      rewritten++;
    }
  }
  return rewritten;
}

async function copyTree(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  let copied = 0;
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (isExcluded(s)) continue;
    if (e.isDirectory()) {
      copied += await copyTree(s, d);
    } else if (e.isFile()) {
      await cp(s, d);
      copied++;
    }
  }
  return copied;
}

/** 递归找出所有被引用的相对资源(JS 的 import 与 HTML 的 src/href) */
async function collectModuleRefs(file) {
  const text = await readFile(file, 'utf8');
  const refs = [];
  const isHtml = /\.html?$/i.test(file);

  if (isHtml) {
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text))) refs.push(m[1]);
    return refs;
  }

  const re = /(?:^|[\s;])(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) refs.push(m[1]);
  // 动态 import('...')
  const re2 = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(text))) refs.push(m[1]);
  return refs;
}

/** 这个引用是不是需要校验的本地文件(排除外链、data:、锚点) */
function isLocalRef(ref) {
  if (!ref) return false;
  if (ref.startsWith('#') || ref.startsWith('//')) return false;
  if (ref.startsWith('data:')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // http: mailto: javascript: 等
  return true;
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** 校验:每个被引用的本地资源在产物里都能真的解析到文件 */
async function verifyReferences() {
  // HTML 也要查 —— index.html 引用的是裸相对路径(js/ui.js、css/*.css),
  // 漏掉 HTML 就等于漏掉了入口页的整条依赖链。
  const files = (await walk(OUT)).filter((f) => /\.(mjs|js|html)$/.test(f));
  const broken = [];
  for (const f of files) {
    const isHtml = /\.html$/i.test(f);
    for (const ref of await collectModuleRefs(f)) {
      if (!isLocalRef(ref)) continue;
      if (!isHtml && !ref.startsWith('.') && !ref.startsWith('/')) {
        // JS 里出现非相对 import = npm 包依赖。本项目零依赖,出现即失败。
        broken.push({ file: path.relative(OUT, f), ref, reason: '非相对 import(零依赖项目不该有)' });
        continue;
      }
      const target = ref.startsWith('/')
        ? path.join(OUT, ref.replace(/^\/+/, ''))
        : path.resolve(path.dirname(f), ref);
      if (!existsSync(target)) {
        broken.push({ file: path.relative(OUT, f), ref, reason: '被引用的文件在产物里不存在' });
      }
    }
  }
  return broken;
}

/** 静态产物里不该出现对后端 API 的硬编码绝对路径依赖 */
async function verifyNoHardApiDependency() {
  const files = (await walk(OUT)).filter((f) => /\.(mjs|js|html)$/.test(f));
  const problems = [];
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    const rel = path.relative(OUT, f);
    // store.js 允许 fetch('/api/health') —— 那是探测,探测失败要能降级。
    // 但除了探测之外不该有别的地方直接打 /api。
    if (rel.endsWith('store.js')) continue;
    if (/fetch\s*\(\s*['"]\/api\//.test(text)) {
      problems.push({ file: rel, reason: '直接 fetch 绝对 /api 路径,静态部署下会失败' });
    }
  }
  return problems;
}

async function main() {
  // 前置检查:源必须齐,否则构建出的是残缺产物(比构建失败更糟,因为看起来像成功了)
  const required = [
    'public/index.html',
    'public/js/store.js',
    'public/js/state.js',
    'public/js/render_timeline.js',
    'public/js/interact.js',
    'public/js/api.js',
    'public/js/ui.js',
    'public/js/importers.js',
    'public/js/exporter.js',
    'lib/midi.mjs',
    'lib/segments.mjs',
    'lib/exporters.mjs',
    'lib/project.mjs',
  ];
  const missing = required.filter((r) => !existsSync(path.join(ROOT, r)));
  if (missing.length) {
    console.error('构建中止 —— 以下源文件还不存在,现在构建只会产出残缺产物:');
    for (const m of missing) console.error('  ✗ ' + m);
    process.exitCode = 1;
    return;
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // public/ 的**内容**铺到 dist/static/ 根,lib/ 作为兄弟目录。
  // 这样 dist/static/ 直接就是站点根 —— 上传即用,不用再往下进一层 public/。
  // 代价是 js/ 里指向 lib/ 的相对路径要从 ../../lib/ 改成 ../lib/,下面 rewriteLibRefs 做这件事。
  let total = 0;
  for (const entry of COPY) {
    const src = path.join(ROOT, entry);
    if (!existsSync(src)) {
      console.error(`缺少目录: ${entry}`);
      process.exitCode = 1;
      return;
    }
    const dest = entry === 'public' ? OUT : path.join(OUT, entry);
    total += await copyTree(src, dest);
  }

  const rewritten = await rewriteLibRefs(OUT);

  // 静态部署说明,免得拿到 dist/static 的人不知道该怎么放
  await writeFile(
    path.join(OUT, 'README.txt'),
    [
      'MIDI → 字幕(静态版)',
      '',
      '把本目录整个上传到任意静态托管即可(GitHub Pages / Vercel / Netlify / nginx)。',
      '',
      '注意:',
      '  - 不能用 file:// 直接双击 index.html 打开。ES module 在 file:// 下会被 CORS 拦掉,',
      '    必须走 HTTP。本地预览可以用仓库里的 scripts/serve-static.mjs。',
      '  - 本版本没有后端,数据存在浏览器 localStorage 里。换浏览器或清站点数据会丢,',
      '    重要项目请备份,或改用服务端模式(数据存在 server/data/)。',
      '  - 入口是 index.html。',
      '',
    ].join('\r\n'),
    'utf8',
  );

  // 产物自检
  const broken = await verifyReferences();
  const hardApi = await verifyNoHardApiDependency();

  console.log(`已构建 → ${path.relative(ROOT, OUT)}`);
  console.log(`  文件数: ${total}  (其中 ${rewritten} 个文件的 lib/ 引用已重写为 ../lib/)`);
  if (!existsSync(path.join(OUT, 'index.html'))) {
    console.error('\n✗ dist/static/index.html 不存在 —— 站点根没有入口页,部署上去会 404');
    process.exitCode = 1;
    return;
  }
  if (broken.length) {
    console.error('\n模块引用校验失败:');
    for (const b of broken) console.error(`  ✗ ${b.file} → "${b.ref}"  (${b.reason})`);
  }
  if (hardApi.length) {
    console.error('\n静态部署兼容性校验失败:');
    for (const p of hardApi) console.error(`  ✗ ${p.file}  (${p.reason})`);
  }
  if (broken.length || hardApi.length) {
    process.exitCode = 1;
    return;
  }
  console.log('  模块引用校验: 全部可解析');
  console.log('  静态兼容性校验: 无绝对 /api 硬依赖');
}

await main();
