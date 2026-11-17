import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { BACKEND_ROOT } from '../src/backend-root.ts'
import { createPool } from '../src/db/client.ts'
import { startServer } from '../src/server.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()

/** 占用一个空闲端口，返回端口号与释放函数。 */
async function occupyPort (): Promise<{ port: number, release: () => Promise<void> }> {
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as AddressInfo).port
  return {
    port,
    release: () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  }
}

/** 直接执行启动入口，收集退出码与 stderr；超时视为失败。 */
function runEntry (port: number): Promise<{ code: number | null, stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, [join(BACKEND_ROOT, 'src', 'server.ts')], {
      cwd: BACKEND_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('启动入口在 30 秒内未退出'))
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

test('启动入口创建连接池、构建应用并监听：返回地址且注入 /health 可用', async () => {
  const { app, pool, address } = await startServer({ config: { ...config, port: 0 }, logger: false })
  try {
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(app.server.listening, true, '启动入口应完成监听')

    const response = await app.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
    await pool.end()
  }
})

test('监听失败时关闭连接池并抛出错误', async () => {
  const { port, release } = await occupyPort()
  const pool = createPool(config)
  try {
    await assert.rejects(
      startServer({ config: { ...config, port }, createPool: () => pool, logger: false }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE',
    )
    await assert.rejects(pool.query('SELECT 1'), /Pool is closed/, '监听失败后连接池应已关闭')
  } finally {
    await release()
  }
})

test('启动入口在端口被占用时以非零码退出', async () => {
  const { port, release } = await occupyPort()
  try {
    const { code, stderr } = await runEntry(port)
    assert.notEqual(code, 0, '端口被占用时应以非零码退出')
    assert.match(stderr, /启动失败/)
    assert.match(stderr, /EADDRINUSE/)
  } finally {
    await release()
  }
})
