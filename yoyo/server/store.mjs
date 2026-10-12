// server/store.mjs — 项目落盘与版本快照(零 npm 依赖,只用 node: 内置模块)
//
// 设计要点(INTERFACE.md 第 5 节):
//  1. 服务端是唯一真相:每次读写都真实访问磁盘,不做内存缓存(否则重启/刷新会看到旧数据)。
//  2. 原子落盘:写 `<name>.json.tmp` → fd.sync()(fsync)→ fs.rename() 原子覆盖。
//     绝不直接 writeFile 覆盖正式文件 —— 写到一半断电/被杀会毁掉用户的项目。
//     rename 在同一目录内是原子的:读者要么看到旧文件,要么看到新文件,绝不会看到半截 JSON。
//  3. 同一项目串行化:每项目一条 Promise 队列(见 enqueue),重叠的 PUT 不会交错写。
//  4. 快照:每次保存成功后在 server/data/.history/<id>/<revision>.json 留一份,只保留最近 30 个。
//
// 目录布局:
//   server/data/<id>.json
//   server/data/.history/<id>/<revision>.json

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 快照保留上限(INTERFACE.md 第 5 节:保留最近 30 个) */
export const SNAPSHOT_LIMIT = 30;

/**
 * 项目 id 白名单。服务端生成的 id 形如 `p_1758000000000_a1b2c3`。
 * 严格校验的意义:GET/PUT/DELETE 的 :id 会参与路径拼接,任何 `.` `/` `\` `%`
 * 都不允许出现,从根上堵死 `../` 目录穿越。
 */
export const PROJECT_ID_RE = /^p_[A-Za-z0-9_]{1,64}$/;

/** 列表接口只读文件头部这么多字节(见 readHeadMeta 的说明) */
const HEAD_BYTES = 4096;

/**
 * 头部元数据正则。serializeProject 保证 id/name/createdAt/updatedAt/revision
 * 这 5 个键固定排在最前面,所以只读 4KB 就能拿到列表所需的全部字段。
 * 名字里可能有转义,故用 `(?:[^"\\]|\\.)*` 而不是 `.*?`。
 */
const HEAD_RE =
  /^\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"createdAt"\s*:\s*(\d+)\s*,\s*"updatedAt"\s*:\s*(\d+)\s*,\s*"revision"\s*:\s*(\d+)/;

// ---------------------------------------------------------------------------
// 错误类型(server.mjs 据此映射 HTTP 状态码)
// ---------------------------------------------------------------------------

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** currentRevision 供客户端 409 后重新拉取(INTERFACE.md 第 5 节) */
export class RevisionConflictError extends StoreError {
  constructor(currentRevision) {
    super('REVISION_CONFLICT', `revision conflict: server current revision is ${currentRevision}`, {
      currentRevision,
    });
  }
}

export class NotFoundError extends StoreError {
  constructor(what = 'project') {
    super('NOT_FOUND', `${what} not found`, { what });
  }
}

export class AlreadyExistsError extends StoreError {
  constructor(id) {
    super('ALREADY_EXISTS', `project ${id} already exists`, { id });
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function isSafeId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

export function newProjectId() {
  return `p_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 固定键序序列化。列表接口靠键序做「只读文件头」优化,所以这里不能换成
 * 任意顺序的 JSON.stringify。
 */
export function serializeProject(p) {
  return (
    JSON.stringify(
      {
        id: p.id ?? null,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        revision: p.revision,
        durationMs: p.durationMs,
        midi: p.midi ?? null,
        tracks: p.tracks ?? [],
        settings: p.settings,
      },
      null,
      2,
    ) + '\n'
  );
}

/** 目录 fsync 是 best-effort:Windows 不允许以只读方式打开目录做 fsync */
async function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    /* 忽略:某些文件系统不支持目录 fsync */
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Windows 上目标文件被别的进程短暂占用(客户端正在 GET 读、杀毒/索引器扫描)时的 rename 错误码 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * EPERM/EACCES/EBUSY 退避重试。
 * 注意:绝不改成「先 unlink 目标再 rename」—— 那会出现「正式文件不存在」的窗口,
 * 破坏原子性。重试只是等占用者松手,提交点仍然是那一次原子的 rename。
 */
async function renameWithRetry(from, to, attempts = 15) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (!RENAME_RETRY_CODES.has(err.code)) throw err;
      await sleep(2 + attempt * 2); // 2,4,6,…,30ms,累计约 240ms
    }
  }
  throw lastError;
}

/**
 * ★ 原子落盘的核心实现 ★
 *   1) 写同目录的 `<target>.tmp`
 *   2) fd.sync() —— fsync,确保内容真正落盘(不是只进了 page cache)
 *   3) fs.rename() —— 同目录改名是原子操作,覆盖正式文件时读者不会看到半截内容
 * 同一项目的所有写入都走 store 的每项目队列,所以 `<target>.tmp` 不会被两个写者同时使用。
 */
async function writeFileAtomic(target, text) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(text, 'utf8');
    await handle.sync(); // ★ fsync:数据 + 元数据刷到磁盘后才可以改名
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await renameWithRetry(tmp, target); // ★ 原子覆盖(禁止直接 writeFile 覆盖正式文件)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {}); // 别留下垃圾 .tmp
    throw err;
  }
  await fsyncDir(dir); // 让 rename 本身也持久化
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * @param {{ dataDir: string, snapshotLimit?: number }} opts
 */
export function createStore({ dataDir, snapshotLimit = SNAPSHOT_LIMIT } = {}) {
  if (!dataDir) throw new Error('createStore: dataDir is required');
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });

  const projectPath = (id) => path.join(root, `${id}.json`);
  const historyDir = (id) => path.join(root, '.history', id);
  const snapshotPath = (id, revision) => path.join(historyDir(id), `${revision}.json`);

  // ---- 每项目 Promise 队列 -------------------------------------------------
  // 同一项目的写操作(create/save/rename/restore/delete)严格串行:前一个结算后
  // 才跑下一个。不同项目互不阻塞(键不同)。
  // `prev.then(task, task)` 保证前一个失败也不会卡死队列。
  const queues = new Map();

  function enqueue(id, task) {
    const prev = queues.get(id) ?? Promise.resolve();
    const run = prev.then(task, task);
    const guarded = run.catch(() => {}); // 队列内部吞掉错误,错误仍由 run 抛给调用者
    queues.set(id, guarded);
    guarded.then(() => {
      if (queues.get(id) === guarded) queues.delete(id);
    });
    return run;
  }

  async function readProjectFile(id) {
    let text;
    try {
      text = await fsp.readFile(projectPath(id), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(text);
  }

  /**
   * 读文件头部拿列表元数据 —— 列表接口不读整份内容(项目可能有几百 KB 的 tracks)。
   * 头部解析失败(超长 name、外部改写过、旧格式)时退回整文件解析,保证不会漏项。
   */
  async function readHeadMeta(file) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      const m = HEAD_RE.exec(head);
      if (m) {
        return {
          id: JSON.parse(`"${m[1]}"`),
          name: JSON.parse(`"${m[2]}"`),
          updatedAt: Number(m[4]),
          revision: Number(m[5]),
        };
      }
    } catch {
      /* 落到下面的整文件解析 */
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    const full = JSON.parse(await fsp.readFile(file, 'utf8'));
    return {
      id: full.id ?? path.basename(file, '.json'),
      name: typeof full.name === 'string' ? full.name : '',
      updatedAt: Number(full.updatedAt) || 0,
      revision: Number(full.revision) || 0,
    };
  }

  async function writeSnapshot(id, revision, project) {
    await writeFileAtomic(snapshotPath(id, revision), serializeProject(project));
  }

  /** 只保留最近 snapshotLimit 个快照,超出的删掉(按 revision 数值排序,不是字典序) */
  async function pruneHistory(id) {
    const rows = await listHistory(id); // 已按 revision 降序
    const extra = rows.slice(snapshotLimit);
    for (const row of extra) {
      await fsp.rm(snapshotPath(id, row.revision), { force: true });
    }
    if (extra.length > 0) {
      console.warn(`[store] pruned ${extra.length} old snapshot(s) of ${id}`);
    }
    return extra.map((r) => r.revision);
  }

  async function listHistory(id) {
    let names;
    try {
      names = await fsp.readdir(historyDir(id));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const rows = [];
    for (const name of names) {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m) continue;
      // savedAt 取 mtime:读 stat 就够了,不必把每份快照内容都读出来
      const st = await fsp.stat(snapshotPath(id, Number(m[1])));
      rows.push({ revision: Number(m[1]), savedAt: Math.round(st.mtimeMs), bytes: st.size });
    }
    rows.sort((a, b) => b.revision - a.revision);
    return rows;
  }

  /** 保存成功后统一走这里:落盘 → 快照 → 裁剪。调用者必须已持有该项目的队列。 */
  async function persist(id, project) {
    await writeFileAtomic(projectPath(id), serializeProject(project));
    try {
      await writeSnapshot(id, project.revision, project);
      await pruneHistory(id);
    } catch (err) {
      // 快照是历史记录,失败不该让「已经成功落盘」的保存变成失败
      console.warn(`[store] snapshot failed for ${id}#${project.revision}:`, err?.message ?? err);
    }
  }

  return {
    dataDir: root,
    projectPath,
    historyDir,
    snapshotPath,
    enqueue,
    listHistory,
    pruneHistory,

    /** @returns {Promise<Array<{id,name,updatedAt,revision}>>} 按 updatedAt 降序 */
    async listProjects() {
      let names;
      try {
        names = await fsp.readdir(root);
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      const rows = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!isSafeId(id)) continue;
        try {
          rows.push(await readHeadMeta(path.join(root, name)));
        } catch (err) {
          console.warn(`[store] skip unreadable project file ${name}:`, err?.message ?? err);
        }
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision);
      return rows;
    },

    /** 整份读盘(唯一真相;没有内存缓存) */
    async readProject(id) {
      if (!isSafeId(id)) return null;
      return readProjectFile(id);
    },

    /**
     * POST /api/projects:分配 id、revision = 1、createdAt/updatedAt = now
     * @param {object} project 已经过 normalizeProject 校验的项目
     */
    async createProject(project) {
      let id = isSafeId(project?.id) ? project.id : newProjectId();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!(await pathExists(projectPath(id)))) break;
        if (isSafeId(project?.id)) throw new AlreadyExistsError(id);
        id = newProjectId(); // 极小概率的 id 撞车 → 换一个
      }
      return enqueue(id, async () => {
        if (await pathExists(projectPath(id))) throw new AlreadyExistsError(id);
        const now = Date.now();
        const stored = {
          ...project,
          id,
          createdAt: Number(project?.createdAt) || now,
          updatedAt: now,
          revision: 1,
        };
        await persist(id, stored);
        return stored;
      });
    },

    /**
     * PUT /api/projects/:id:revision 始终由服务端持有并 +1,客户端无法自己指定。
     * 读-校验-写在同一条队列里完成,所以并发 PUT 的基线检查是原子的。
     *
     * 基线怎么取(缺一不可):
     *   1. 显式传了 baseRevision 用它;
     *   2. 没传但 body 里的 project 带了 revision,用**它**当基线。
     *
     * 第 2 条是必须的:客户端 PUT 的是「它以为的当前版本」,那个 revision 就是它的基线。
     * 只认显式 baseRevision、把 body 里的 revision 一律当噪声丢掉的话,
     * 任何只发 { project } 的客户端拿着过期副本也能写成功,
     * 乐观并发形同虚设 —— 后写静默覆盖前写。
     *
     * @param {number|null} baseRevision 与当前 revision 不一致 → RevisionConflictError
     */
    async saveProject(id, project, { baseRevision = null } = {}) {
      if (!isSafeId(id)) throw new NotFoundError('project');
      const effectiveBase =
        baseRevision !== null && baseRevision !== undefined
          ? baseRevision
          : project && typeof project === 'object' && project.revision !== undefined && project.revision !== null
            ? project.revision
            : null;
      return enqueue(id, async () => {
        const current = await readProjectFile(id);
        if (!current) throw new NotFoundError('project');
        if (effectiveBase !== null) {
          const base = Number(effectiveBase);
          // 基线必须是「当前这一版」;解析不出数字(脏输入)也按冲突处理,宁可让客户端重读
          if (!Number.isFinite(base) || base !== Number(current.revision)) {
            throw new RevisionConflictError(Number(current.revision));
          }
        }
        const now = Date.now();
        const next = {
          ...project,
          id,
          createdAt: Number(current.createdAt) || now, // id/createdAt 不可被客户端改写
          updatedAt: now,
          revision: Number(current.revision) + 1,
        };
        await persist(id, next);
        return next;
      });
    },

    /** PATCH /api/projects/:id:{ name } */
    async renameProject(id, name) {
      if (!isSafeId(id)) throw new NotFoundError('project');
      return enqueue(id, async () => {
        const current = await readProjectFile(id);
        if (!current) throw new NotFoundError('project');
        const next = { ...current, name, updatedAt: Date.now(), revision: Number(current.revision) + 1 };
        await persist(id, next);
        return next;
      });
    },

    /** POST /api/projects/:id/restore:用旧快照覆盖,revision 继续 +1(不回退) */
    async restoreRevision(id, revision) {
      if (!isSafeId(id)) throw new NotFoundError('project');
      return enqueue(id, async () => {
        const current = await readProjectFile(id);
        if (!current) throw new NotFoundError('project');
        let snapText;
        try {
          snapText = await fsp.readFile(snapshotPath(id, revision), 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') throw new NotFoundError(`snapshot ${revision}`);
          throw err;
        }
        const snapshot = JSON.parse(snapText);
        const now = Date.now();
        const next = {
          ...snapshot,
          id,
          createdAt: Number(current.createdAt) || now,
          updatedAt: now,
          revision: Number(current.revision) + 1,
        };
        await persist(id, next);
        return next;
      });
    },

    /** DELETE /api/projects/:id:删正式文件 + 整段历史 */
    async deleteProject(id) {
      if (!isSafeId(id)) throw new NotFoundError('project');
      return enqueue(id, async () => {
        const existed = await pathExists(projectPath(id));
        await fsp.rm(projectPath(id), { force: true });
        await fsp.rm(historyDir(id), { recursive: true, force: true });
        return existed;
      });
    },

    /** 等待队列排空(进程退出前用),避免半途丢掉正在写的保存 */
    async drain() {
      while (queues.size > 0) {
        await Promise.allSettled([...queues.values()]);
      }
    },
  };
}
