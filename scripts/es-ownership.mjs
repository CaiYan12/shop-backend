/**
 * Elasticsearch 进程归属判定（C47 补充，独立审查 P1-B）。
 *
 * `es-dev.mjs` 用 Start-Process 拉起启动器后会拿到它自己的 PID。监听 9201 的
 * 服务 JVM 通常不是这个 PID 本身，而是它的后代；端口也可能在预检后被其他进程抢占。
 * 因此「监听者是不是本次启动拉起的」必须同时满足：
 * 1. 监听者 PID 等于启动器 PID，或沿 ParentProcessId 能上溯到启动器；
 * 2. 监听者的可执行路径或命令行能佐证来自本次的 ES 安装目录。
 *
 * 本模块只做纯计算，进程信息由调用方注入，默认套件可直接覆盖各种归属场景。
 */

export const DEFAULT_MAX_DEPTH = 16

/** Windows 路径统一大小写与分隔符后再比较。 */
function normalizePath (value) {
  return String(value).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
}

function containsHome (value, home) {
  if (typeof value !== 'string' || value === '') return false
  if (typeof home !== 'string' || home.trim() === '') return false
  return normalizePath(value).includes(normalizePath(home))
}

/**
 * 沿 ParentProcessId 上溯，判断监听者与启动器的关系。
 * 父链在到达启动器前中断（查不到父进程、父 PID 非法或成环）时返回 null。
 *
 * @param {number} listenerPid
 * @param {number} launcherPid
 * @param {(pid: number) => ({ pid?: number, parentPid?: number | null, execPath?: string | null, commandLine?: string | null } | null | undefined)} lookup
 * @param {number} [maxDepth]
 * @returns {'self' | 'descendant' | null}
 */
export function traceToLauncher (
  listenerPid,
  launcherPid,
  lookup,
  maxDepth = DEFAULT_MAX_DEPTH,
) {
  if (!Number.isInteger(listenerPid) || !Number.isInteger(launcherPid)) return null
  if (listenerPid === launcherPid) return 'self'
  if (typeof lookup !== 'function') return null

  let current = listenerPid
  const visited = new Set([current])
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const info = lookup(current)
    if (info === null || info === undefined) return null
    const parentPid = info.parentPid
    if (!Number.isInteger(parentPid) || parentPid <= 0) return null
    if (parentPid === launcherPid) return 'descendant'
    if (visited.has(parentPid)) return null
    visited.add(parentPid)
    current = parentPid
  }
  return null
}

/**
 * 判定监听连接器的进程是否属于本次启动。
 *
 * @param {{
 *   listenerPid: number,
 *   launcherPid: number,
 *   esHome: string,
 *   lookup: (pid: number) => ({ pid?: number, parentPid?: number | null, execPath?: string | null, commandLine?: string | null } | null | undefined),
 *   maxDepth?: number,
 * }} input
 * @returns {{ owned: boolean, relation: 'self' | 'descendant' | null, reason: string }}
 */
export function isOwnedByLaunch ({
  listenerPid,
  launcherPid,
  esHome,
  lookup,
  maxDepth = DEFAULT_MAX_DEPTH,
}) {
  const relation = traceToLauncher(listenerPid, launcherPid, lookup, maxDepth)
  if (relation === null) {
    return {
      owned: false,
      relation,
      reason: `监听进程 ${String(listenerPid)} 不是启动器 ${String(launcherPid)} 的后代（父链中断或 PID 不符）`,
    }
  }
  if (typeof esHome !== 'string' || esHome.trim() === '') {
    return {
      owned: false,
      relation,
      reason: '未提供 ES 安装目录，无法佐证监听进程的来源',
    }
  }

  const listener = lookup(listenerPid)
  if (listener === null || listener === undefined) {
    return {
      owned: false,
      relation,
      reason: `无法读取监听进程 ${String(listenerPid)} 的可执行路径与命令行，归属无法证明`,
    }
  }
  const evidence = containsHome(listener.execPath, esHome) || containsHome(listener.commandLine, esHome)
  if (!evidence) {
    return {
      owned: false,
      relation,
      reason: `监听进程 ${String(listenerPid)} 的可执行路径与命令行都不在 ES 安装目录 ${esHome} 内`,
    }
  }

  return {
    owned: true,
    relation,
    reason: relation === 'self'
      ? '监听进程就是本次启动的启动器'
      : `监听进程 ${String(listenerPid)} 是启动器 ${String(launcherPid)} 的后代，且来自 ES 安装目录`,
  }
}
