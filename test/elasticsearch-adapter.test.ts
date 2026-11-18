import test from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import { ElasticsearchProductIndexAdapter } from '../src/search/elasticsearch-adapter.ts'
import { IndexAlreadyExistsError } from '../src/search/index-rebuild.ts'

/**
 * P1-A：更新别名是「已生效但响应丢失」的高风险点。ES 客户端在 HTTP 200 下
 * 也可能返回 acknowledged=false / errors=true；适配器必须把它当失败抛出，
 * 否则重建流程会误以为别名没有切换，进而删掉正在服务的新索引。
 */

interface AliasActionResultRecord {
  status?: number
  error?: unknown
  add?: { status?: number, error?: unknown, index?: string, alias?: string }
  remove?: { status?: number, error?: unknown, index?: string, alias?: string }
}

interface UpdateAliasesResponse {
  acknowledged?: boolean
  errors?: boolean
  action_results?: Array<boolean | AliasActionResultRecord>
}

interface MappingResponse {
  [index: string]: { mappings: { properties: Record<string, unknown> } }
}

class StubIndicesClient {
  readonly requests: unknown[] = []
  response: UpdateAliasesResponse = { acknowledged: true }

  readonly createRequests: unknown[] = []
  createError?: unknown

  readonly mappingRequests: unknown[] = []
  mappingResponse: MappingResponse = {}

  async updateAliases (request: unknown): Promise<UpdateAliasesResponse> {
    this.requests.push(request)
    return this.response
  }

  async create (request: unknown): Promise<unknown> {
    this.createRequests.push(request)
    if (this.createError !== undefined) throw this.createError
    return { acknowledged: true }
  }

  async getMapping (request: unknown): Promise<MappingResponse> {
    this.mappingRequests.push(request)
    return this.mappingResponse
  }
}

function makeAdapter (stub: StubIndicesClient): ElasticsearchProductIndexAdapter {
  const client = { indices: stub } as unknown as Client
  return new ElasticsearchProductIndexAdapter(client)
}

test('更新别名：acknowledged=false 视为失败并抛错', async () => {
  const stub = new StubIndicesClient()
  stub.response = { acknowledged: false }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', ['products_v2'], ['products_v1']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /acknowledged=false/)
      return true
    },
  )
  assert.equal(stub.requests.length, 1, '请求已发出，失败来自响应体')
})

test('更新别名：errors=true 视为失败并抛错', async () => {
  const stub = new StubIndicesClient()
  stub.response = { acknowledged: true, errors: true }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', ['products_v2'], []),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /errors=true/)
      return true
    },
  )
})

test('建索引：ES 400 resource_already_exists_exception 识别为专门错误', async () => {
  const stub = new StubIndicesClient()
  stub.createError = Object.assign(new Error('resource_already_exists_exception'), {
    meta: {
      statusCode: 400,
      body: { error: { type: 'resource_already_exists_exception' } },
    },
  })
  const adapter = makeAdapter(stub)

  await assert.rejects(adapter.createIndex('products_v1'), (error: unknown) => {
    assert.ok(error instanceof IndexAlreadyExistsError)
    assert.equal(error.index, 'products_v1')
    return true
  })
  assert.equal(stub.createRequests.length, 1)
})

test('建索引：其它 400 原样上抛，不误判为版本冲突', async () => {
  const stub = new StubIndicesClient()
  const failure = Object.assign(new Error('mapper_parsing_exception'), {
    meta: { statusCode: 400, body: { error: { type: 'mapper_parsing_exception' } } },
  })
  stub.createError = failure
  const adapter = makeAdapter(stub)

  await assert.rejects(adapter.createIndex('products_v1'), (error: unknown) => {
    assert.equal(error, failure)
    assert.equal(error instanceof IndexAlreadyExistsError, false)
    return true
  })
})

test('回读 mapping：只保留 type / analyzer，忽略其它字段', async () => {
  const stub = new StubIndicesClient()
  stub.mappingResponse = {
    products_v1: {
      mappings: {
        properties: {
          name: { type: 'search_as_you_type', analyzer: 'smartcn', index: true },
          displayPriceCents: { type: 'long' },
        },
      },
    },
  }
  const adapter = makeAdapter(stub)

  assert.deepEqual(await adapter.getMapping('products_v1'), {
    name: { type: 'search_as_you_type', analyzer: 'smartcn' },
    displayPriceCents: { type: 'long' },
  })
  assert.deepEqual(stub.mappingRequests, [{ index: 'products_v1' }])
})

test('更新别名：acknowledged=true 且无 errors 时成功，动作同时包含 add 与 remove', async () => {
  const stub = new StubIndicesClient()
  const adapter = makeAdapter(stub)

  await adapter.updateAlias('products', ['products_v2'], ['products_v1'])

  assert.equal(stub.requests.length, 1)
  assert.deepEqual(stub.requests[0], {
    actions: [
      { add: { index: 'products_v2', alias: 'products' } },
      { remove: { index: 'products_v1', alias: 'products' } },
    ],
  })
})
test('更新别名：errors=true 时把 action_results 中失败的项带进错误消息', async () => {
  const stub = new StubIndicesClient()
  // 与请求顺序一一对应：add products_v2 成功，remove products_v1 失败。
  stub.response = { acknowledged: true, errors: true, action_results: [true, false] }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', ['products_v2'], ['products_v1']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /errors=true/)
      assert.match(error.message, /失败动作/)
      assert.match(error.message, /第 2 项 remove products_v1 -> products/)
      assert.doesNotMatch(error.message, /add products_v2/, '成功项不得出现在失败列表里')
      return true
    },
  )
})

test('更新别名：真实 ES 对象数组 action_results 的错误含动作、索引与状态码', async () => {
  const stub = new StubIndicesClient()
  // 真实 ES 的形状：add 成功、remove 404，errors=true。
  stub.response = {
    acknowledged: true,
    errors: true,
    action_results: [
      { add: { status: 200 } },
      { remove: { status: 404, error: { type: 'aliases_not_found_exception' } } },
    ],
  }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', ['products_v2'], ['products_v1']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /失败动作/)
      assert.match(error.message, /第 2 项 remove products_v1 -> products/)
      assert.match(error.message, /状态码 404/)
      assert.doesNotMatch(error.message, /add products_v2/, '成功项不得出现在失败列表里')
      return true
    },
  )
})

test('更新别名：errors=false 但逐项 404 时仍按失败处理', async () => {
  const stub = new StubIndicesClient()
  stub.response = {
    acknowledged: true,
    errors: false,
    action_results: [{ remove: { status: 404 } }],
  }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', [], ['products_v1']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /remove products_v1 -> products/)
      assert.match(error.message, /状态码 404/)
      return true
    },
  )
})

test('更新别名：外层 status 的 action_results（真实 ES）含动作、索引与状态码', async () => {
  const stub = new StubIndicesClient()
  // ES 9.x 实际返回：动作名下只有 index/alias，status/error 在对象外层。
  stub.response = {
    acknowledged: true,
    errors: true,
    action_results: [
      { add: { index: 'products_v2', alias: 'products' }, status: 200 },
      { remove: { index: 'products_v1', alias: 'products' }, status: 404 },
    ],
  }
  const adapter = makeAdapter(stub)

  await assert.rejects(
    adapter.updateAlias('products', ['products_v2'], ['products_v1']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /失败动作/)
      assert.match(error.message, /第 2 项 remove products_v1 -> products/)
      assert.match(error.message, /状态码 404/)
      assert.doesNotMatch(error.message, /add products_v2/, '成功项不得出现在失败列表里')
      return true
    },
  )
})
