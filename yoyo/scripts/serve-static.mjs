/**
 * 极简静态文件服务器 —— 用于本地预览构建产物 dist/static/。
 *
 * 为什么需要它:ES module 在 file:// 协议下会被浏览器 CORS 拦掉,
 * 所以 dist/static/index.html 没法双击打开。必须走 HTTP。
 *
 * 零依赖。默认伺服 dist/static,端口 4518(DSH_STATIC_PORT 可覆盖)。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'dist', 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * 解析请求路径到磁盘路径,并挡住路径穿越。
 * 返回 null 表示应当拒绝。
 */
export function resolveSafe(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码
  }
  if (decoded.includes('\0')) return null;
  // 统一分隔符后再判断,Windows 下 '\' 也能穿越
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return null;

  const rel = normalized.replace(/^\/+/, '');
  const target = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

export function createStaticServer(root = ROOT) {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0].split('#')[0];
    const target = resolveSafe(root, urlPath === '/' ? '/index.html' : urlPath);

    if (!target) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 禁止访问');
      return;
    }

    let st;
    try {
      st = await fsp.stat(target);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 未找到: ' + urlPath);
      return;
    }

    // 目录 → 找 index.html
    let file = target;
    if (st.isDirectory()) {
      file = path.join(target, 'index.html');
      try {
        st = await fsp.stat(file);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 目录下没有 index.html');
        return;
      }
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      // 预览时别缓存,免得改了看不到
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** 起服务并解析实际端口。返回 { server, port, url, close } */
export async function startStaticServer({ root = ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = createStaticServer(root);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: `http://${host}:${actual}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// 直接运行:起服务并打印地址
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('还没构建。先跑: node scripts/build-static.mjs');
    process.exit(1);
  }
  const port = Number(process.env.DSH_STATIC_PORT || 4518);
  const s = await startStaticServer({ port });
  console.log(`静态预览: ${s.url}`);
  console.log(`伺服目录: ${ROOT}`);
  console.log('按 Ctrl+C 停止。');
}
