import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 重建互斥（第四轮复审）：互斥由操作系统持有的资源表示——绑定本机回环端口。
 *
 * 同一台机器上同时跑两次重建时，两次都会读到相同的旧索引集合、各自 add 自己的新索引，
 * 别名因此同时指向两个物理索引，HTTP 列表出现重复条目。互斥把重建串成一条。
 *
 * 为什么用端口而不是锁文件：文件锁要靠「读文件判断持有者是否存活」来接管过期锁，
 * 「判断」与「接管」之间仍是竞态（旧持有者恰好复活、两个进程同时判过期等）。
 * 端口由内核保证独占：listen 成功即持有，进程退出时操作系统关闭 socket，
 * 因此不存在过期锁，也不存在接管流程。EADDRINUSE 就是「已有重建在跑」，本次立即失败。
 *
 * .run/es-rebuild.owner.json 只是诊断用的身份记录（pid、进程启动时间、可执行路径、
 * 端口、获取时间）；它不参与互斥，写失败也不影响已经取得的端口持有。
 *
 * 默认端口 19201，可由构造参数或环境变量 ES_REBUILD_LOCK_PORT 覆盖。
 * 默认记录路径 <仓库根>/.run/es-rebuild.owner.json（已 gitignore），不依赖 cwd。
 */

/** 仓库根：src/search 与 dist/search 都是两级目录，因此本表达式两者通用。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 只绑本机回环：不暴露到局域网，也不依赖防火墙规则。 */
const LOOPBACK_HOST = '127.0.0.1'

/** 默认互斥端口；刻意避开 ES 9201、测试 ES 9301 与服务端 3001。 */
export const DEFAULT_REBUILD_LOCK_PORT = 19201

/** 覆盖默认互斥端口的环境变量。 */
export const REBUILD_LOCK_PORT_ENV = 'ES_REBUILD_LOCK_PORT'

/** 当前进程的启动时间：用「现在 - 已运行时长」估算，同一进程内恒定。 */
const PROCESS_START_TIME = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()

export interface RebuildProcessIdentity {
  pid: number
  /** 进程启动时间（UTC ISO）；与可执行路径一起用于人工核对身份记录。 */
  startTime: string
  /** 可执行路径。 */
  execPath: string
}

export interface RebuildLockOwner extends RebuildProcessIdentity {
  /** 持有的回环端口。 */
  port: number
  /** 取得互斥的时间（UTC ISO）。 */
  acquiredAt: string
}

export interface RebuildLockOptions {
  /** 互斥端口；默认 19201，再被 ES_REBUILD_LOCK_PORT 覆盖。 */
  port?: number
  /** 诊断身份记录路径；默认 <仓库根>/.run/es-rebuild.owner.json。 */
  ownerPath?: string
  /** 当前进程身份；测试注入。 */
  identity?: RebuildProcessIdentity
  /** 当前时间；测试注入。 */
  now?: () => number
}

export interface RebuildLock {
  /** 本次持有的回环端口。 */
  readonly port: number
  /** 诊断身份记录路径。 */
  readonly ownerPath: string
  readonly owner: RebuildLockOwner
  /** 身份记录写失败时的说明；写失败不影响互斥。 */
  readonly ownerRecordWarning?: string
  /** 幂等释放：关闭监听端口并删除自己的诊断记录。 */
  release (): Promise<void>
}

/** 重建互斥失败：端口已被占用、无法绑定或端口参数非法。 */
export class RebuildLockError extends Error {
  readonly port: number | undefined

  constructor (message: string, options: ErrorOptions & { port?: number } = {}) {
    super(message, options)
    this.name = 'RebuildLockError'
    this.port = options.port
  }
}

function describeError (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertLockPort (port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RebuildLockError('重建互斥端口必须是 1–65535 的整数，当前值无法使用。')
  }
}

/** 默认互斥端口：显式环境变量优先；非法值直接失败，不静默回退。 */
export function defaultRebuildLockPort (env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REBUILD_LOCK_PORT_ENV]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_REBUILD_LOCK_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RebuildLockError(
      `${REBUILD_LOCK_PORT_ENV} 必须是 1–65535 的整数，当前值无法使用。`,
    )
  }
  return port
}

/** 默认诊断记录：仓库根的 .run 目录（已 gitignore），不依赖启动时的 cwd。 */
export function defaultRebuildLockOwnerPath (): string {
  return join(REPO_ROOT, '.run', 'es-rebuild.owner.json')
}

/**
 * 绑定回环端口；成功即取得互斥。
 * EADDRINUSE 表示同机已有重建持有该端口：立即失败并给出端口与排查命令。
 */
interface BoundLoopbackPort {
  server: Server
  /** 断开当前与随后到达的全部连接；release 不等待客户端主动断开。 */
  closeConnections: () => void
}

function bindLoopbackPort (port: number): Promise<BoundLoopbackPort> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const sockets = new Set<Socket>()
    let closing = false
    // 记录每条已接受的连接：release 时逐个 destroy，不依赖客户端断开。
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      if (closing) socket.destroy()
    })
    const closeConnections = (): void => {
      closing = true
      // Node 26.13.1 的 net.Server 没有 closeAllConnections（实测 undefined）；
      // 有则调用，真正的兜底是销毁记录下来的 socket。
      const withCloseAll = server as Server & { closeAllConnections?: () => void }
      withCloseAll.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    }
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE') {
        reject(
          new RebuildLockError(
            `重建互斥端口 ${port} 已被占用（127.0.0.1:${port}）：已有一次索引重建在运行。` +
              '本次重建不等待，立即失败；请等它结束后重试。' +
              `若确认没有重建在跑，用 netstat -ano | findstr :${port} 查看占用进程并结束它。`,
            { cause: error, port },
          ),
        )
        return
      }
      reject(
        new RebuildLockError(
          `无法绑定重建互斥端口 127.0.0.1:${port}` +
            `（${error.code ?? describeError(error)}）：${describeError(error)}。`,
          { cause: error, port },
        ),
      )
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      // 监听成功后保留一个空错误监听，避免迟到的 error 事件让进程崩溃。
      server.on('error', () => {})
      resolve({ server, closeConnections })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true })
  })
}

class LoopbackPortRebuildLock implements RebuildLock {
  readonly port: number
  readonly ownerPath: string
  readonly owner: RebuildLockOwner
  readonly ownerRecordWarning?: string
  private readonly server: Server
  private readonly closeConnections: () => void
  private released = false

  constructor (
    server: Server,
    closeConnections: () => void,
    ownerPath: string,
    owner: RebuildLockOwner,
    ownerRecordWarning?: string,
  ) {
    this.server = server
    this.closeConnections = closeConnections
    this.ownerPath = ownerPath
    this.owner = owner
    this.ownerRecordWarning = ownerRecordWarning
    this.port = owner.port
  }

  async release (): Promise<void> {
    if (this.released) return
    this.released = true
    // 先停止接收新连接；close 的回调要等所有连接结束，不能先 await 它。
    const closed = new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
    // 主动断开现存连接（含空闲的本地 TCP 客户端），否则 close 会一直等它断开。
    this.closeConnections()
    await closed
    try {
      unlinkSync(this.ownerPath)
    } catch {
      // 记录只是诊断信息：不存在或删除失败都不影响互斥。
    }
  }
}

/**
 * 取得重建互斥：绑定 127.0.0.1:<port>。
 *
 * 成功后把身份写入 ownerPath 供人工排查；身份记录不参与互斥，
 * 因此已存在旧记录会被直接覆盖，写入失败也只记录一条 warning。
 */
export async function acquireRebuildLock (
  options: RebuildLockOptions = {},
): Promise<RebuildLock> {
  const port = options.port ?? defaultRebuildLockPort()
  assertLockPort(port)
  const ownerPath = options.ownerPath ?? defaultRebuildLockOwnerPath()
  const identity = options.identity ?? {
    pid: process.pid,
    startTime: PROCESS_START_TIME,
    execPath: process.execPath,
  }
  const now = options.now ?? Date.now

  const { server, closeConnections } = await bindLoopbackPort(port)
  const owner: RebuildLockOwner = {
    pid: identity.pid,
    startTime: identity.startTime,
    execPath: identity.execPath,
    port,
    acquiredAt: new Date(now()).toISOString(),
  }

  let ownerRecordWarning: string | undefined
  try {
    mkdirSync(dirname(ownerPath), { recursive: true })
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
  } catch (error) {
    ownerRecordWarning =
      `诊断记录 ${ownerPath} 写入失败（${describeError(error)}）` +
      `；互斥仍由 127.0.0.1:${port} 持有`
  }

  return new LoopbackPortRebuildLock(server, closeConnections, ownerPath, owner, ownerRecordWarning)
}
