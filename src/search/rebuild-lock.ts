import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 重建互斥锁（第三轮复审）。
 *
 * 同一台机器上同时跑两次重建时，两次都会读到相同的旧索引集合、各自 add 自己的新索引，
 * 别名因此同时指向两个物理索引，HTTP 列表出现重复条目。文件名锁把重建串成一条：
 * 取得锁才能开始，成功与异常两条路径都在 finally 里释放。
 *
 * 锁记录 pid、进程启动时间与可执行路径（与 scripts/es-stop.mjs 的归属校验同一风格）：
 * - 持有者进程仍存活 → 立即失败，消息里给出持有者与锁文件位置；
 * - 持有者已消失 → 视为过期，重命名隔离后清理并接管；
 * - pid 被别的进程复用时，启动时间或可执行路径与记录不符，同样按过期处理。
 *
 * 默认路径相对仓库根解析（<repo>/.run/es-rebuild.lock，已 gitignore），不依赖 cwd；
 * 测试注入临时路径即可。
 */

/** 仓库根：src/search 与 dist/search 都是两级目录，因此本表达式两者通用。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 取得锁的最大尝试次数：覆盖「刚释放」「刚清理过期锁」两类竞争。 */
const MAX_ACQUIRE_ATTEMPTS = 3

/** 当前进程的启动时间：用「现在 - 已运行时长」估算，同一进程内恒定。 */
const PROCESS_START_TIME = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()

export interface RebuildProcessIdentity {
  pid: number
  /** 进程启动时间（UTC ISO）；用来识别 PID 复用。 */
  startTime: string
  /** 可执行路径；用来佐证持有者身份。 */
  execPath: string
}

export interface RebuildLockOwner extends RebuildProcessIdentity {
  /** 取得锁的时间（UTC ISO）。 */
  acquiredAt: string
  /** 本次获取的唯一标记：释放时只删自己写的那份锁。 */
  token: string
}

/** 进程探针：默认实现只读取当前进程的身份，测试可注入。 */
export interface RebuildLockProcessProbe {
  isAlive (pid: number): boolean
  /** 读取指定进程的启动时间与可执行路径；无法读取时返回 null。 */
  processInfo (pid: number): { startTime: string | null, execPath: string | null } | null
}

export interface RebuildLockOptions {
  /** 锁文件路径；默认 <仓库根>/.run/es-rebuild.lock。 */
  lockPath?: string
  /** 当前进程身份；测试注入。 */
  identity?: RebuildProcessIdentity
  /** 进程探针；测试注入。 */
  probe?: RebuildLockProcessProbe
  /** 当前时间；测试注入。 */
  now?: () => number
}

export interface RebuildLock {
  readonly path: string
  readonly owner: RebuildLockOwner
  /** 接管前清理掉的过期持有者；没有接管时为 undefined。 */
  readonly recoveredFrom?: RebuildLockOwner
  /** 幂等释放；只删除自己写的那份锁。 */
  release (): void
}

/** 重建锁失败：持有者仍在、锁文件损坏或清理过期锁失败。 */
export class RebuildLockError extends Error {
  readonly lockPath: string

  constructor (message: string, lockPath: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RebuildLockError'
    this.lockPath = lockPath
  }
}

/** 默认锁文件：仓库根的 .run 目录（已 gitignore），不依赖启动时的 cwd。 */
export function defaultRebuildLockPath (): string {
  return join(REPO_ROOT, '.run', 'es-rebuild.lock')
}

/** 默认探针：用 process.kill(pid, 0) 判存活；只有当前进程能读到启动时间与可执行路径。 */
export const defaultRebuildLockProbe: RebuildLockProcessProbe = {
  isAlive (pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // Windows 上权限不足同样说明进程存在，只有 ESRCH 才是已消失。
      const code = (error as NodeJS.ErrnoException).code
      return code === 'EPERM' || code === 'EACCES'
    }
  },
  processInfo (pid) {
    if (pid !== process.pid) return null
    return { startTime: PROCESS_START_TIME, execPath: process.execPath }
  },
}

type HolderStatus = 'held-by-self' | 'held-by-other' | 'stale'

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeOwner (owner: RebuildLockOwner): string {
  return `pid=${owner.pid}，启动时间=${owner.startTime}，可执行路径=${owner.execPath}，获取时间=${owner.acquiredAt}`
}

/** Windows 路径统一大小写与分隔符后再比较。 */
function sameExecPath (left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left.replace(/\//g, '\\').toLowerCase() === right.replace(/\//g, '\\').toLowerCase()
}

function invalidLock (lockPath: string, reason: string, cause?: unknown): RebuildLockError {
  return new RebuildLockError(
    `重建锁 ${lockPath} 存在但内容无法解析（${reason}）：可能是写入中断或手工改动。` +
      '为避免两个重建同时改别名，本次立即失败；请确认没有重建在跑后删除该文件再重试。',
    lockPath,
    cause === undefined ? undefined : { cause },
  )
}

function parseLockOwner (lockPath: string, raw: string): RebuildLockOwner {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidLock(lockPath, describeError(error), error)
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidLock(lockPath, '不是 JSON 对象')
  const record = parsed as Partial<RebuildLockOwner>
  const pid = record.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw invalidLock(lockPath, 'pid 不是正整数')
  }
  const { startTime, execPath, acquiredAt, token } = record
  if (typeof startTime !== 'string' || startTime === '') throw invalidLock(lockPath, '缺少 startTime')
  if (typeof execPath !== 'string' || execPath === '') throw invalidLock(lockPath, '缺少 execPath')
  if (typeof acquiredAt !== 'string' || acquiredAt === '') throw invalidLock(lockPath, '缺少 acquiredAt')
  if (typeof token !== 'string' || token === '') throw invalidLock(lockPath, '缺少 token')
  return { pid, startTime, execPath, acquiredAt, token }
}

/** 读取锁文件；不存在时返回 undefined（调用方重试创建）。 */
function readLockFile (lockPath: string): RebuildLockOwner | undefined {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RebuildLockError(
      `无法读取重建锁 ${lockPath}：${describeError(error)}。`,
      lockPath,
      { cause: error },
    )
  }
  return parseLockOwner(lockPath, raw)
}

/** 用 'wx' 独占创建锁文件：已存在时返回 false，成功时返回 true。 */
function writeLockOwner (lockPath: string, owner: RebuildLockOwner): boolean {
  let fd: number
  try {
    fd = openSync(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw new RebuildLockError(
      `无法创建重建锁 ${lockPath}：${describeError(error)}。`,
      lockPath,
      { cause: error },
    )
  }
  try {
    writeSync(fd, `${JSON.stringify(owner, null, 2)}\n`)
  } catch (error) {
    try {
      closeSync(fd)
    } catch {}
    try {
      unlinkSync(lockPath)
    } catch {}
    throw new RebuildLockError(
      `写入重建锁 ${lockPath} 失败：${describeError(error)}。`,
      lockPath,
      { cause: error },
    )
  }
  closeSync(fd)
  return true
}

/** 判定现有锁的持有者：仍被自己 / 仍是别人 / 已过期（可接管）。 */
function assessHolder (
  existing: RebuildLockOwner,
  identity: RebuildProcessIdentity,
  probe: RebuildLockProcessProbe,
): HolderStatus {
  if (existing.pid === identity.pid) {
    // 同一 PID：启动时间与可执行路径都一致才算「本进程持有」；否则是 PID 被复用后的过期锁。
    return existing.startTime === identity.startTime && sameExecPath(existing.execPath, identity.execPath)
      ? 'held-by-self'
      : 'stale'
  }
  if (!probe.isAlive(existing.pid)) return 'stale'
  const info = probe.processInfo(existing.pid)
  // 读不到其它进程的身份时保守处理：存活即视为仍持有。
  if (info === null) return 'held-by-other'
  if (info.startTime !== null && info.startTime !== existing.startTime) return 'stale'
  if (info.execPath !== null && !sameExecPath(info.execPath, existing.execPath)) return 'stale'
  return 'held-by-other'
}

class FileRebuildLock implements RebuildLock {
  readonly path: string
  readonly owner: RebuildLockOwner
  readonly recoveredFrom?: RebuildLockOwner
  private released = false

  constructor (path: string, owner: RebuildLockOwner, recoveredFrom?: RebuildLockOwner) {
    this.path = path
    this.owner = owner
    this.recoveredFrom = recoveredFrom
  }

  release (): void {
    if (this.released) return
    this.released = true
    let current: RebuildLockOwner | undefined
    try {
      current = readLockFile(this.path)
    } catch {
      // 锁文件损坏或不可读：不在这里覆盖或删除别人的记录。
      return
    }
    if (current === undefined || current.token !== this.owner.token) return
    try {
      unlinkSync(this.path)
    } catch {
      // 释放失败留给下一次获取时的存活检查报告，不覆盖调用方的原始错误。
    }
  }
}

/**
 * 取得重建锁；被存活进程持有或锁文件损坏时立即失败。
 * 过期锁用 rename 原子隔离后再删除，避免两个进程同时 unlink 对方的锁。
 */
export function acquireRebuildLock (options: RebuildLockOptions = {}): RebuildLock {
  const lockPath = options.lockPath ?? defaultRebuildLockPath()
  const identity = options.identity ?? {
    pid: process.pid,
    startTime: PROCESS_START_TIME,
    execPath: process.execPath,
  }
  const probe = options.probe ?? defaultRebuildLockProbe
  const now = options.now ?? Date.now
  mkdirSync(dirname(lockPath), { recursive: true })

  let recoveredFrom: RebuildLockOwner | undefined
  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const owner: RebuildLockOwner = {
      pid: identity.pid,
      startTime: identity.startTime,
      execPath: identity.execPath,
      acquiredAt: new Date(now()).toISOString(),
      token: randomUUID(),
    }
    if (writeLockOwner(lockPath, owner)) return new FileRebuildLock(lockPath, owner, recoveredFrom)

    const existing = readLockFile(lockPath)
    // 另一个进程在读取前刚释放：直接重试创建。
    if (existing === undefined) continue

    const status = assessHolder(existing, identity, probe)
    if (status === 'held-by-self') {
      throw new RebuildLockError(
        `重建锁 ${lockPath} 已被当前进程持有（${describeOwner(existing)}）：同一进程内不能同时跑两个重建。` +
          '请等待正在执行的重建结束后重试。',
        lockPath,
      )
    }
    if (status === 'held-by-other') {
      throw new RebuildLockError(
        `重建锁 ${lockPath} 已被占用：${describeOwner(existing)}。` +
          `持有者进程 ${existing.pid} 仍在运行，本次重建立即失败；请等待它结束后重试。` +
          '若确认该进程已不存在，可删除锁文件后重试。',
        lockPath,
      )
    }

    const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    try {
      renameSync(lockPath, quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new RebuildLockError(
        `重建锁 ${lockPath} 的持有者已消失，但清理过期锁失败：${describeError(error)}。`,
        lockPath,
        { cause: error },
      )
    }
    recoveredFrom = existing
    try {
      unlinkSync(quarantine)
    } catch {}
  }

  throw new RebuildLockError(
    `连续 ${MAX_ACQUIRE_ATTEMPTS} 次尝试仍未取得重建锁 ${lockPath}，可能有其他重建在反复抢占。`,
    lockPath,
  )
}
