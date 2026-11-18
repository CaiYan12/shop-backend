import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import { createDb, createPool } from '../src/db/client.ts'
import { ERROR_CODES } from '../src/errors.ts'
import { OPENAPI_FILE, serializeOpenApiDocument } from '../src/openapi.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { loadTestConfig } from './helpers/test-config.ts'

const config = loadTestConfig()
let pool: Pool
let app: AppInstance

before(async () => {
  pool = createPool(config)
  app = await createApp({ db: createDb(pool), config, search: new FakeProductSearchAdapter() })
  await app.ready()
})

after(async () => {
  await app.close()
  await pool.end()
})

interface SchemaObject {
  $ref?: string
  type?: string
  const?: unknown
  enum?: unknown[]
  nullable?: boolean
  anyOf?: SchemaObject[]
  required?: string[]
  properties?: Record<string, SchemaObject>
  items?: SchemaObject
  [key: string]: unknown
}

interface OperationObject {
  operationId?: string
  tags?: string[]
  responses?: Record<string, { content?: Record<string, { schema?: SchemaObject }> }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: SchemaObject }> }
}

interface OpenApiDocument {
  openapi?: string
  info?: { title?: string, version?: string }
  servers?: Array<{ url?: string }>
  tags?: Array<{ name?: string }>
  paths?: Record<string, Record<string, OperationObject>>
  components?: { schemas?: Record<string, SchemaObject> }
}

/** 六个业务路径与约定的 operationId（D58、D64）；健康检查与文档路由不计入。 */
const BUSINESS_OPERATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['get', '/api/products', 'listProducts'],
  ['get', '/api/products/suggestions', 'listSuggestions'],
  ['get', '/api/products/{slug}', 'getProduct'],
  ['get', '/api/products/{slug}/recommendations', 'listRecommendations'],
  ['get', '/api/categories', 'listCategories'],
  ['post', '/api/purchase-check', 'checkPurchase'],
]

/** 响应 schema 的命名组件（D64、D67）：名字取 schema 的 `$id`。 */
const COMPONENT_NAMES = [
  'CategoriesResponse',
  'CategoryListItem',
  'ErrorResponse',
  'ProductCategory',
  'ProductCoverImage',
  'ProductDetailBlock',
  'ProductDetailResponse',
  'ProductDimension',
  'ProductHighlight',
  'ProductListItem',
  'ProductListResponse',
  'ProductRecommendationsResponse',
  'ProductSearchListItem',
  'ProductSuggestionHighlight',
  'ProductSuggestionItem',
  'ProductSuggestionsResponse',
  'ProductVariant',
  'PurchaseCheckProduct',
  'PurchaseCheckResponse',
  'PurchaseCheckVariant',
]

/**
 * 每个操作实际可能返回的错误响应（D62）：只声明运行时真会出现的状态码。
 * 购买校验带请求体，因此额外声明请求体解析阶段的 413 / 415。
 */
const ERROR_RESPONSES: Readonly<Record<string, readonly string[]>> = {
  listProducts: ['400', '500', '503'],
  listSuggestions: ['400', '500', '503'],
  getProduct: ['400', '404', '500'],
  listRecommendations: ['400', '404', '500'],
  listCategories: ['500'],
  checkPurchase: ['400', '404', '409', '413', '415', '500'],
}

function document (): OpenApiDocument {
  return app.swagger() as unknown as OpenApiDocument
}

function schemas (doc: OpenApiDocument): Record<string, SchemaObject> {
  return doc.components?.schemas ?? {}
}

/** 递归收集文档里出现的全部 `$ref` 字符串。 */
function collectRefs (value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs)
    return refs
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child)
      else collectRefs(child, refs)
    }
  }
  return refs
}

/** 递归判断文档里是否出现某个关键字（用于断言 `nullable` 未被改写出来）。 */
function hasKeyword (value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKeyword(item, keyword))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, child]) => key === keyword || hasKeyword(child, keyword),
    )
  }
  return false
}

function responseSchema (doc: OpenApiDocument, path: string, method: string): SchemaObject {
  const schema = doc.paths?.[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema
  assert.ok(schema !== undefined, `${method.toUpperCase()} ${path} 应声明 200 响应 schema`)
  return schema
}

test('文档插件注册成功：swagger() 可取出 3.1.0 文档', async () => {
  const doc = document()
  assert.equal(doc.openapi, '3.1.0')
  assert.equal(doc.info?.title, '商品列表与详情 API')
  assert.equal(doc.info?.version, '0.1.0')
  assert.deepEqual(doc.servers, [{ url: `http://127.0.0.1:${config.port}` }])
  assert.deepEqual(doc.tags?.map((tag) => tag.name), ['商品', '商品类型', '购买校验'])
})

test('恰好 6 个业务路径，operationId 与约定一致', async () => {
  const doc = document()
  const paths = Object.keys(doc.paths ?? {})

  assert.deepEqual(
    paths.slice().sort(),
    BUSINESS_OPERATIONS.map(([, path]) => path).sort(),
    '业务路径应恰好是约定的六个；健康检查与文档路由不应进入契约',
  )
  assert.equal(paths.includes('/health'), false, '健康检查不应进入契约路径')
  assert.equal(paths.includes('/openapi.json'), false, '文档路由不应进入契约路径')
  assert.equal(paths.some((path) => path.startsWith('/documentation')), false, '文档界面不应进入契约路径')

  for (const [method, path, operationId] of BUSINESS_OPERATIONS) {
    const operation = doc.paths?.[path]?.[method]
    assert.ok(operation !== undefined, `${method.toUpperCase()} ${path} 应存在`)
    assert.equal(operation.operationId, operationId, `${method.toUpperCase()} ${path} 的 operationId`)
  }
})

test('响应 schema 引用命名组件：组件名取 $id，不出现 def-N', async () => {
  const doc = document()
  const components = schemas(doc)
  const names = Object.keys(components)

  assert.deepEqual(names.slice().sort(), COMPONENT_NAMES, '组件应恰好是这些命名 schema')
  assert.equal(names.length, COMPONENT_NAMES.length, '组件数量应与约定一致')
  assert.equal(names.some((name) => /^def-\d+$/.test(name)), false, '组件名不应是 def-N 序号')

  for (const [method, path] of BUSINESS_OPERATIONS) {
    const schema = responseSchema(doc, path, method)
    const ref = schema.$ref
    assert.ok(typeof ref === 'string', `${method.toUpperCase()} ${path} 的 200 响应应引用命名组件`)
    assert.match(ref, /^#\/components\/schemas\/[A-Z][A-Za-z]+$/, '响应引用应指向命名组件')
    const name = ref.slice('#/components/schemas/'.length)
    assert.ok(Object.hasOwn(components, name), `响应引用的组件 ${name} 应存在`)
  }

  const refs = collectRefs(doc)
  assert.equal(refs.length > 0, true, '文档应包含内部引用')
  for (const ref of refs) {
    assert.match(ref, /^#\/components\/schemas\/[A-Z][A-Za-z]+$/, `引用 ${ref} 应指向命名组件`)
    assert.ok(Object.hasOwn(components, ref.slice('#/components/schemas/'.length)), `引用 ${ref} 应可解析`)
  }
})

test('每个操作声明实际可能返回的错误响应，统一引用 ErrorResponse', async () => {
  const doc = document()

  for (const [method, path, operationId] of BUSINESS_OPERATIONS) {
    const responses = doc.paths?.[path]?.[method]?.responses ?? {}
    const errorStatuses = Object.keys(responses).filter((status) => status !== '200').sort()

    assert.deepEqual(
      errorStatuses,
      [...ERROR_RESPONSES[operationId]!].sort(),
      `${operationId} 的错误响应状态码应与约定一致`,
    )

    for (const status of errorStatuses) {
      const schema = responses[status]?.content?.['application/json']?.schema
      assert.equal(
        schema?.$ref,
        '#/components/schemas/ErrorResponse',
        `${operationId} 的 ${status} 响应应引用 ErrorResponse`,
      )
    }
  }
})

test('ErrorResponse 组件：七个业务码枚举 + { path, message } 明细', async () => {
  const response = schemas(document()).ErrorResponse
  assert.ok(response !== undefined, 'ErrorResponse 应是命名组件')

  const error = response.properties?.error
  assert.ok(error !== undefined, 'ErrorResponse 应包含 error 对象')
  assert.deepEqual(error.required?.slice().sort(), ['code', 'message'], 'code 与 message 必填')
  assert.deepEqual(error.properties?.code?.enum, [...ERROR_CODES], 'code 应枚举七个业务码')
  assert.equal(error.properties?.message?.type, 'string')

  const details = error.properties?.details
  assert.ok(details !== undefined, 'details 应为可选数组')
  assert.equal(details.type, 'array')
  assert.deepEqual(details.items?.required?.slice().sort(), ['message', 'path'], '明细元素固定 path 与 message')
  assert.equal(details.items?.properties?.path?.type, 'string')
  assert.equal(details.items?.properties?.message?.type, 'string')
})

test('购买校验三分支保留 anyOf + const，不出现单值 enum 与 nullable', async () => {
  const doc = document()
  const schema = responseSchema(doc, '/api/purchase-check', 'post')
  assert.equal(schema.$ref, '#/components/schemas/PurchaseCheckResponse')

  const response = schemas(doc).PurchaseCheckResponse
  assert.ok(response !== undefined, 'PurchaseCheckResponse 应是命名组件')
  assert.equal(Array.isArray(response.anyOf), true, '三分支应以 anyOf 表达')
  assert.equal(response.anyOf?.length, 3, '应恰好三个分支')

  const branches = response.anyOf ?? []
  const results = branches.map((branch) => branch.properties?.result?.const)
  assert.deepEqual(results, ['purchasable', 'blocked', 'blocked'], 'result 判别字段应以 const 保留')

  for (const branch of branches) {
    const result = branch.properties?.result
    assert.equal(Object.hasOwn(result ?? {}, 'enum'), false, 'result 不应被改写成 enum')
    assert.equal(result?.enum, undefined, 'result 不应带 enum')
  }

  const insufficientStock = branches[1]?.properties?.reason
  assert.equal(insufficientStock?.const, 'INSUFFICIENT_STOCK')
  assert.equal(insufficientStock?.enum, undefined, 'reason 不应被改写成 enum')

  const priceChanged = branches[2]
  assert.equal(priceChanged?.properties?.reason?.const, 'PRICE_CHANGED')
  assert.equal(priceChanged?.properties?.priceChanged?.const, true)
  assert.equal(priceChanged?.required?.includes('requestedUnitPriceCents'), true, '价格变化分支必带请求价')

  assert.equal(hasKeyword(doc, 'nullable'), false, '3.1 文档不应出现 nullable 改写')
})

test('提交的 openapi.json 与当前应用生成结果一致', async () => {
  const live = document()
  let actual: string
  try {
    actual = readFileSync(OPENAPI_FILE, 'utf8')
  } catch {
    assert.fail(`缺少契约产物 ${OPENAPI_FILE}，请运行 pnpm openapi:generate`)
  }

  // `servers` 随运行配置的端口变化（D64），由「servers 反映实际配置端口」单独断言；
  // 产物同步只比较与部署环境无关的契约内容，避免各 checkout 的 .env 端口不同导致误报。
  const committed = JSON.parse(actual) as OpenApiDocument
  assert.equal(
    actual,
    serializeOpenApiDocument({ ...live, servers: committed.servers }),
    'openapi.json 已过期，请运行 pnpm openapi:generate 重新生成',
  )
})

test('请求 schema 内联：请求体不引用命名组件', async () => {
  const doc = document()
  const body = doc.paths?.['/api/purchase-check']?.post?.requestBody?.content?.['application/json']?.schema

  assert.ok(body !== undefined, '购买校验应声明请求体 schema')
  // 请求侧用 `$ref` 会让现有校验器恒返回 400（见 Phase 3 实现笔记），因此必须内联。
  assert.equal(body.$ref, undefined, '请求体 schema 必须内联，不能引用共享组件')
  assert.equal(body.type, 'object')
  assert.deepEqual(body.required?.slice().sort(), ['quantity', 'sku', 'slug'])
  assert.deepEqual(
    Object.keys(body.properties ?? {}).sort(),
    ['expectedUnitPriceCents', 'quantity', 'sku', 'slug'],
  )
})

test('servers 反映实际配置端口', async () => {
  const customPort = 4123
  const customApp = await createApp({
    db: createDb(pool),
    config: { ...config, port: customPort },
    search: new FakeProductSearchAdapter(),
  })
  try {
    await customApp.ready()
    const doc = customApp.swagger() as unknown as OpenApiDocument
    assert.deepEqual(doc.servers, [{ url: `http://127.0.0.1:${customPort}` }])
  } finally {
    await customApp.close()
  }
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
