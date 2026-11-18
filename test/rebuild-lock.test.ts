import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_REBUILD_LOCK_PORT,
  REBUILD_LOCK_PORT_ENV,
  RebuildLockError,
  acquireRebuildLock,
  defaultRebuildLockOwnerPath,
  defaultRebuildLockPort,
  type RebuildLockOwner,
} from '../src/search/rebuild-lock.ts'
import { freePort } from './helpers/free-port.ts'

/**
 * 重建互斥（第四轮复审）：互斥是操作系统持有的回环端口。
 * 默认套件不依赖 Elasticsearch；用临时目录与高位空闲端口覆盖持有、释放与身份记录。
 */

const DIR = mkdtempSync(join(tmpdir(), 'shop-rebuild-lock-test-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

function ownerPath (name: string): string {
  return join(DIR, name)
}

function listenExternal (port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => resolve(server))
  })
}

function closeServer (server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** release 不允许被空闲客户端的断开时机拖住：超时即判失败。 */
async function withTimeout<T> (promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超过 ' + String(ms) + ' ms 未完成')), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('默认互斥端口 19201，身份记录按仓库根解析，不依赖 cwd', () => {
  assert.equal(DEFAULT_REBUILD_LOCK_PORT, 19201)
  assert.equal(defaultRebuildLockPort({}), 19201)
  assert.equal(defaultRebuildLockPort({ [REBUILD_LOCK_PORT_ENV]: ' 23456 ' }), 23456)
  assert.throws(
    () => defaultRebuildLockPort({ [REBUILD_LOCK_PORT_ENV]: '9201.5' }),
    (error: unknown) => {
      assert.ok(error instanceof RebuildLockError)
      assert.match(error.message, /1–65535/)
      return true
    },
  )
  const expected = fileURLToPath(new URL('../.run/es-rebuild.owner.json', import.meta.url))
  assert.equal(defaultRebuildLockOwnerPath(), expected)
  assert.equal(isAbsolute(defaultRebuildLockOwnerPath()), true)
  assert.equal(defaultRebuildLockOwnerPath().endsWith(join('.run', 'es-rebuild.owner.json')), true)
})

test('同一端口第二次获取立即失败：消息含端口与 netstat 排查命令', async () => {
  const port = await freePort()
  const first = await acquireRebuildLock({ port, ownerPath: ownerPath('held.owner.json') })
  try {
    await assert.rejects(
      acquireRebuildLock({ port, ownerPath: ownerPath('held-second.owner.json') }),
      (error: unknown) => {
        assert.ok(error instanceof RebuildLockError)
        assert.equal(error.port, port)
        assert.ok(error.message.includes('127.0.0.1:' + String(port)), '必须指出被占用的端口')
        assert.ok(
          error.message.includes('netstat -ano | findstr :' + String(port)),
          '必须给出排查命令',
        )
        assert.match(error.message, /已有一次索引重建在运行/)
        return true
      },
    )
  } finally {
    await first.release()
  }
})

test('释放后端口立即可以再次获取，身份记录随释放删除', async () => {
  const port = await freePort()
  const path = ownerPath('release.owner.json')
  const first = await acquireRebuildLock({ port, ownerPath: path })
  assert.equal(existsSync(path), true)

  await first.release()
  assert.equal(existsSync(path), false)

  const second = await acquireRebuildLock({ port, ownerPath: path })
  try {
    assert.equal(existsSync(path), true)
  } finally {
    await second.release()
  }
  assert.equal(existsSync(path), false)
})

test('端口被外部监听时获取失败：不写身份记录，外部监听结束后可再获取', async () => {
  const port = await freePort()
  const external = await listenExternal(port)
  const path = ownerPath('external.owner.json')
  try {
    await assert.rejects(acquireRebuildLock({ port, ownerPath: path }), (error: unknown) => {
      assert.ok(error instanceof RebuildLockError)
      assert.equal(error.port, port)
      assert.match(error.message, /已被占用/)
      return true
    })
    assert.equal(existsSync(path), false, '绑定失败不得写身份记录')
  } finally {
    await closeServer(external)
  }

  const after = await acquireRebuildLock({ port, ownerPath: path })
  await after.release()
})

test('身份记录包含 pid / 启动时间 / 可执行路径 / 端口 / 获取时间', async () => {
  const port = await freePort()
  const path = ownerPath('identity.owner.json')
  const lock = await acquireRebuildLock({
    port,
    ownerPath: path,
    now: () => Date.parse('2026-11-18T00:00:00.000Z'),
  })
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RebuildLockOwner
    assert.equal(record.pid, process.pid)
    assert.equal(record.port, port)
    assert.equal(record.execPath, process.execPath)
    assert.equal(record.startTime, lock.owner.startTime)
    assert.equal(record.acquiredAt, '2026-11-18T00:00:00.000Z')
  } finally {
    await lock.release()
  }
  assert.equal(existsSync(path), false)
})

test('身份记录写失败不影响互斥：仍持有端口，释放不抛错', async () => {
  const port = await freePort()
  // 用已存在的目录当记录路径：写文件必然失败（EISDIR）。
  const lock = await acquireRebuildLock({ port, ownerPath: DIR })
  try {
    assert.ok(lock.ownerRecordWarning !== undefined, '应记录写失败的原因')
    assert.match(lock.ownerRecordWarning ?? '', /写入失败/)
    await assert.rejects(
      acquireRebuildLock({ port, ownerPath: ownerPath('other.owner.json') }),
      (error: unknown) => {
        assert.ok(error instanceof RebuildLockError)
        assert.equal(error.port, port)
        return true
      },
    )
  } finally {
    await lock.release()
  }

  const again = await acquireRebuildLock({ port, ownerPath: ownerPath('after-warning.owner.json') })
  await again.release()
})

test('已存在的旧身份记录不参与互斥：直接取得端口并覆盖记录', async () => {
  const port = await freePort()
  const path = ownerPath('stale.owner.json')
  writeFileSync(
    path,
    JSON.stringify({
      pid: 424242,
      startTime: '2020-01-01T00:00:00.000Z',
      execPath: 'C:\\dead\\node.exe',
      port: 19999,
      acquiredAt: '2020-01-01T00:00:00.000Z',
    }),
    'utf8',
  )

  const lock = await acquireRebuildLock({ port, ownerPath: path })
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RebuildLockOwner
    assert.equal(record.pid, process.pid, '旧记录应被直接覆盖，不经判断/接管')
    assert.equal(record.port, port)
  } finally {
    await lock.release()
  }
  assert.equal(existsSync(path), false)
})

/**
 * P2（第五轮复审）：本地 TCP 客户端连上互斥端口后不断开，
 * 旧 release() 的 server.close(cb) 会一直等它关闭，重建进程迟迟退不出。
 * 修复后 release 主动断开连接，1 秒内完成且端口可重新获取。
 */
test('已连接的空闲 TCP 客户端不阻塞 release：1 秒内释放、socket 被断开、端口可重新获取', { timeout: 5000 }, async () => {
  const port = await freePort()
  const path = ownerPath('idle-client.owner.json')
  const lock = await acquireRebuildLock({ port, ownerPath: path })
  const client: Socket = connect({ host: '127.0.0.1', port })
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    const disconnected = new Promise<void>((resolve) => client.once('close', () => resolve()))

    const started = Date.now()
    await withTimeout(lock.release(), 1000, 'release')
    const elapsedMs = Date.now() - started

    assert.ok(elapsedMs < 1000, 'release 必须在 1 秒内完成（实际 ' + String(elapsedMs) + ' ms）')
    await disconnected
    assert.equal(client.destroyed, true, '服务端必须主动断开客户端连接')
  } finally {
    client.destroy()
    await lock.release()
  }

  const again = await acquireRebuildLock({ port, ownerPath: path })
  await again.release()
})
