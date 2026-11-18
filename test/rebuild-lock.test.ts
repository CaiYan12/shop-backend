import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireRebuildLock,
  defaultRebuildLockPath,
  RebuildLockError,
  type RebuildLockOwner,
  type RebuildLockProcessProbe,
} from '../src/search/rebuild-lock.ts'

/**
 * 重建互斥锁（第三轮复审）：默认套件不依赖 Elasticsearch，
 * 用临时目录与注入的进程探针覆盖持有、接管与释放。
 */

const DIR = mkdtempSync(join(tmpdir(), 'shop-rebuild-lock-test-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

const deadProbe: RebuildLockProcessProbe = {
  isAlive: () => false,
  processInfo: () => null,
}

function lockRecord (pid: number, startTime: string, execPath: string, token = 'stale-token'): RebuildLockOwner {
  return {
    pid,
    startTime,
    execPath,
    acquiredAt: '2020-01-01T00:00:00.000Z',
    token,
  }
}

function writeLock (path: string, record: RebuildLockOwner): void {
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
}

test('默认锁文件按仓库根解析，不依赖 cwd', () => {
  const expected = fileURLToPath(new URL('../.run/es-rebuild.lock', import.meta.url))
  assert.equal(defaultRebuildLockPath(), expected)
  assert.equal(isAbsolute(defaultRebuildLockPath()), true)
  assert.equal(defaultRebuildLockPath().endsWith(join('.run', 'es-rebuild.lock')), true)
})

test('释放后可以再次获取：锁文件随获取出现、随释放删除', () => {
  const path = join(DIR, 'release.lock')
  const first = acquireRebuildLock({ lockPath: path })
  assert.equal(existsSync(path), true)
  assert.equal(first.owner.pid, process.pid)

  first.release()
  assert.equal(existsSync(path), false)

  const second = acquireRebuildLock({ lockPath: path })
  try {
    assert.equal(existsSync(path), true)
    assert.notEqual(second.owner.token, first.owner.token, '每次获取都应有独立标记')
  } finally {
    second.release()
  }
  assert.equal(existsSync(path), false)
})

test('持有中再次获取立即失败：提示持有者与锁文件位置', () => {
  const path = join(DIR, 'held.lock')
  const lock = acquireRebuildLock({ lockPath: path })
  try {
    assert.throws(() => acquireRebuildLock({ lockPath: path }), (error: unknown) => {
      assert.ok(error instanceof RebuildLockError)
      assert.equal(error.lockPath, path)
      assert.ok(error.message.includes(path), '必须指出锁文件位置')
      assert.ok(error.message.includes(`pid=${process.pid}`), '必须指出持锁进程')
      assert.match(error.message, /已被当前进程持有/)
      return true
    })
  } finally {
    lock.release()
  }
  assert.equal(existsSync(path), false)
})

test('持有者已消失：视为过期，清理后接管', () => {
  const path = join(DIR, 'stale.lock')
  writeLock(path, lockRecord(424242, '2020-01-01T00:00:00.000Z', 'C:\\dead\\node.exe'))

  const lock = acquireRebuildLock({ lockPath: path, probe: deadProbe })
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RebuildLockOwner
    assert.equal(record.pid, process.pid, '锁内容应换成当前进程')
    assert.notEqual(record.token, 'stale-token')
    assert.equal(lock.recoveredFrom?.pid, 424242, '应报告被清理的过期持有者')
  } finally {
    lock.release()
  }
  assert.equal(existsSync(path), false)
})

test('PID 仍存活但启动时间不同（PID 被复用）：按过期处理并接管', () => {
  const path = join(DIR, 'reused-pid.lock')
  writeLock(path, lockRecord(424242, '2020-01-01T00:00:00.000Z', process.execPath))
  const probe: RebuildLockProcessProbe = {
    isAlive: () => true,
    processInfo: () => ({ startTime: '2026-01-01T00:00:00.000Z', execPath: process.execPath }),
  }

  const lock = acquireRebuildLock({ lockPath: path, probe })
  try {
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid)
  } finally {
    lock.release()
  }
})

test('持有者仍存活且身份一致：立即失败并给出持有者信息', () => {
  const path = join(DIR, 'alive.lock')
  writeLock(path, lockRecord(424242, '2020-01-01T00:00:00.000Z', process.execPath))
  const probe: RebuildLockProcessProbe = {
    isAlive: () => true,
    processInfo: () => ({ startTime: '2020-01-01T00:00:00.000Z', execPath: process.execPath }),
  }

  assert.throws(() => acquireRebuildLock({ lockPath: path, probe }), (error: unknown) => {
    assert.ok(error instanceof RebuildLockError)
    assert.ok(error.message.includes('pid=424242'))
    assert.ok(error.message.includes(path))
    assert.match(error.message, /已被占用/)
    return true
  })
  assert.equal(existsSync(path), true, '失败时不得删除仍有效的锁')
})

test('锁文件损坏：立即失败并提示人工确认后删除', () => {
  const path = join(DIR, 'corrupt.lock')
  writeFileSync(path, '{ 这不是 JSON', 'utf8')

  assert.throws(() => acquireRebuildLock({ lockPath: path }), (error: unknown) => {
    assert.ok(error instanceof RebuildLockError)
    assert.ok(error.message.includes(path))
    assert.match(error.message, /内容无法解析/)
    assert.match(error.message, /删除该文件再重试/)
    return true
  })
  assert.equal(existsSync(path), true, '损坏的锁不擅自删除')
})
