import test from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import { ElasticsearchProductIndexAdapter } from '../src/search/elasticsearch-adapter.ts'

/**
 * P1-A：更新别名是「已生效但响应丢失」的高风险点。ES 客户端在 HTTP 200 下
 * 也可能返回 acknowledged=false / errors=true；适配器必须把它当失败抛出，
 * 否则重建流程会误以为别名没有切换，进而删掉正在服务的新索引。
 */

interface UpdateAliasesResponse {
  acknowledged?: boolean
  errors?: boolean
}

class StubIndicesClient {
  readonly requests: unknown[] = []
  response: UpdateAliasesResponse = { acknowledged: true }

  async updateAliases (request: unknown): Promise<UpdateAliasesResponse> {
    this.requests.push(request)
    return this.response
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
