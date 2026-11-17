import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool } from '../src/db/client.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let app: AppInstance

before(async () => {
  pool = createPool(config)
  app = await createApp({ db: createDb(pool), config })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

interface OpenApiDocument {
  openapi?: string
  info?: { title?: string, version?: string }
  servers?: Array<{ url?: string }>
  tags?: Array<{ name?: string }>
  paths?: Record<string, unknown>
}

function document (): OpenApiDocument {
  return app.swagger() as unknown as OpenApiDocument
}

test('文档插件注册成功：swagger() 可取出 3.1.0 文档', async () => {
  const doc = document()
  assert.equal(doc.openapi, '3.1.0')
  assert.equal(doc.info?.title, '商品列表与详情 API')
  assert.equal(doc.info?.version, '0.1.0')
  assert.deepEqual(doc.servers, [{ url: `http://127.0.0.1:${config.port}` }])
  assert.deepEqual(doc.tags?.map((tag) => tag.name), ['商品', '商品类型', '购买校验'])

  const paths = Object.keys(doc.paths ?? {})
  assert.equal(paths.includes('/health'), false, '健康检查不应进入契约路径')
  assert.equal(paths.includes('/openapi.json'), false, '文档路由不应进入契约路径')
  assert.equal(paths.some((path) => path.startsWith('/documentation')), false, '文档界面不应进入契约路径')
})

test('文档界面路由与 /openapi.json 可访问', async () => {
  const ui = await app.inject({ method: 'GET', url: '/documentation' })
  assert.equal(ui.statusCode, 200)
  assert.match(ui.headers['content-type'] ?? '', /text\/html/)

  const spec = await app.inject({ method: 'GET', url: '/openapi.json' })
  assert.equal(spec.statusCode, 200)
  const body = spec.json() as OpenApiDocument
  assert.equal(body.openapi, '3.1.0')
  assert.equal(body.info?.title, '商品列表与详情 API')
})
