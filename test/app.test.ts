import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { RowDataPacket } from 'mysql2'
import type { Pool } from 'mysql2/promise'
import { Type } from 'typebox'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool } from '../src/db/client.ts'
import { AppError } from '../src/errors.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let app: AppInstance

before(async () => {
  pool = createPool(config)
  app = await createApp({ db: createDb(pool), config, search: new FakeProductSearchAdapter() })
  // 探针路由：只用于观察应用工厂装配出的校验与错误映射，不出现在文档里。
  app.get('/__probe/query', {
    schema: {
      hide: true,
      querystring: Type.Object({
        page: Type.Integer({ minimum: 1 }),
      }),
    },
  }, async (request) => request.query)

  app.get('/__probe/cross-field', {
    schema: { hide: true },
  }, async () => {
    throw new AppError('VALIDATION_FAILED', '价格下限不能大于价格上限。', [
      { path: 'querystring/priceMinCents', message: '价格下限不能大于价格上限。' },
    ])
  })

  app.get('/__probe/boom', {
    schema: { hide: true },
  }, async () => {
    throw new Error('内部细节：连接口令 abc123')
  })

  // 带请求体的探针路由：观察请求体解析阶段的客户端错误如何映射。
  app.post('/__probe/body', {
    schema: {
      hide: true,
      body: Type.Object({ name: Type.String() }),
    },
  }, async (request) => request.body)
})

after(async () => {
  await app.close()
  await pool.end()
})

test('应用工厂返回未监听实例：注入 /health 返回 200', async () => {
  assert.equal(app.server.listening, false, '应用构建后不应监听端口')

  const response = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})

test('未知路由返回 404 与 NOT_FOUND 统一信封', async () => {
  const response = await app.inject({ method: 'GET', url: '/no-such-route' })
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), {
    error: {
      code: 'NOT_FOUND',
      message: '请求的接口不存在。',
    },
  })
})

test('查询参数校验失败返回 400 与 VALIDATION_FAILED，details 带字段位置', async () => {
  const response = await app.inject({ method: 'GET', url: '/__probe/query?page=0' })
  assert.equal(response.statusCode, 400)

  const body = response.json()
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.message, '请求参数校验失败。')
  assert.equal(Array.isArray(body.error.details), true, 'details 应为数组')
  assert.equal(body.error.details[0].path, 'querystring/page')
  assert.equal(typeof body.error.details[0].message, 'string')
})

test('跨字段校验失败返回 400 与 VALIDATION_FAILED，明细指向具体字段', async () => {
  const response = await app.inject({ method: 'GET', url: '/__probe/cross-field' })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), {
    error: {
      code: 'VALIDATION_FAILED',
      message: '价格下限不能大于价格上限。',
      details: [
        { path: 'querystring/priceMinCents', message: '价格下限不能大于价格上限。' },
      ],
    },
  })
})

test('未预期异常返回 500 与 INTERNAL_ERROR，响应体不含堆栈与内部细节', async () => {
  const response = await app.inject({ method: 'GET', url: '/__probe/boom' })
  assert.equal(response.statusCode, 500)

  const body = response.json()
  assert.deepEqual(body, {
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务内部错误。',
    },
  })
  assert.equal(response.body.includes('内部细节'), false, '响应体不应包含异常消息')
  assert.equal(response.body.includes('abc123'), false, '响应体不应包含异常消息')
  assert.equal(response.body.includes('stack'), false, '响应体不应包含堆栈')
})

test('畸形 JSON 请求体返回 400 与 VALIDATION_FAILED，仍走统一信封', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__probe/body',
    headers: { 'content-type': 'application/json' },
    payload: '{"name":',
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), {
    error: {
      code: 'VALIDATION_FAILED',
      message: '请求体格式错误。',
    },
  })
})

test('不支持的 Content-Type 返回 415 与 VALIDATION_FAILED', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__probe/body',
    // text/plain 有内置解析器，会落到 schema 校验；这里用完全没有解析器的类型。
    headers: { 'content-type': 'application/xml' },
    payload: '<name>探针</name>',
  })

  assert.equal(response.statusCode, 415)
  assert.deepEqual(response.json(), {
    error: {
      code: 'VALIDATION_FAILED',
      message: '不支持的 Content-Type。',
    },
  })
})

test('超过 bodyLimit 的请求体返回 413 与 VALIDATION_FAILED', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/__probe/body',
    headers: { 'content-type': 'application/json' },
    // Fastify 默认 bodyLimit 为 1 MiB；这里刻意超出 1 个字节以上。
    payload: JSON.stringify({ name: 'x'.repeat(1024 * 1024) }),
  })

  assert.equal(response.statusCode, 413)
  assert.deepEqual(response.json(), {
    error: {
      code: 'VALIDATION_FAILED',
      message: '请求体过大。',
    },
  })
})

test('应用关闭只释放自身资源：不关闭调用方持有的连接池', async () => {
  const ownedPool = createPool(config)
  const ownedApp = await createApp({
    db: createDb(ownedPool),
    config,
    search: new FakeProductSearchAdapter(),
  })
  try {
    await ownedApp.ready()
    await ownedApp.close()

    const [rows] = await ownedPool.query<RowDataPacket[]>('SELECT 1 AS ok')
    assert.equal(rows[0]?.ok, 1, '应用关闭后连接池仍可查询')
  } finally {
    await ownedPool.end()
  }
})
