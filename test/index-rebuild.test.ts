import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexRebuildError, rebuildProductIndex } from '../src/search/index-rebuild.ts'
import type { ProductSearchDocument } from '../src/search/product-snapshot.ts'
import { RecordingProductIndexAdapter } from './helpers/recording-index-adapter.ts'

const FIXTURE: ProductSearchDocument[] = [
  {
    productId: 1,
    slug: 'airpods-max',
    name: 'Apple AirPods Max 头戴式降噪耳机',
    brand: 'Apple',
    model: 'A2096',
    categoryName: '音频设备',
    categorySlug: 'audio',
    sales: 1280,
    displayPriceCents: 399_900,
  },
  {
    productId: 2,
    slug: 'keychron-k8',
    name: 'Keychron K8 机械键盘',
    brand: 'Keychron',
    model: 'K8',
    categoryName: '键盘外设',
    categorySlug: 'peripherals',
    sales: 860,
    displayPriceCents: 49_900,
  },
  {
    // V20：上限金额超过 integer 的 2,147,483,647，映射必须是 long。
    productId: 3,
    slug: 'probe-huge-price',
    name: '超 32 位金额探针商品',
    brand: 'Probe',
    model: 'LONG',
    categoryName: '显示设备',
    categorySlug: 'displays',
    sales: 1,
    displayPriceCents: 9_999_999_999,
  },
]

const ALIAS = 'products_test'

function run (adapter: RecordingProductIndexAdapter) {
  return rebuildProductIndex(adapter, {
    loadSnapshot: async () => FIXTURE,
    alias: ALIAS,
  })
}

test('正常重建按固定顺序执行，_id 用 slug，切换后别名指向新索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  const result = await run(adapter)

  assert.equal(result.index, 'products_v1')
  assert.equal(result.documentCount, FIXTURE.length)
  assert.deepEqual(result.previousIndices, [])
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'])
  assert.deepEqual(adapter.steps.map((step) => step.name), [
    'listProductIndices',
    'aliasIndices',
    'createIndex',
    'bulk',
    'refresh',
    'getMapping',
    'count',
    'getDocuments',
    'updateAlias',
    'aliasIndices',
    'searchTotal',
  ])

  const bulkStep = adapter.steps.find((step) => step.name === 'bulk')
  assert.equal(bulkStep?.name, 'bulk')
  if (bulkStep?.name !== 'bulk') throw new Error('缺少 bulk 步骤')
  assert.deepEqual(bulkStep.ids, FIXTURE.map((document) => document.slug))

  const updateStep = adapter.steps.find((step) => step.name === 'updateAlias')
  assert.equal(updateStep?.name, 'updateAlias')
  if (updateStep?.name !== 'updateAlias') throw new Error('缺少 updateAlias 步骤')
  assert.deepEqual(updateStep.add, ['products_v1'])
  assert.deepEqual(updateStep.remove, [])

  const stored = adapter.indices.get('products_v1')
  assert.ok(stored !== undefined)
  assert.deepEqual([...stored.keys()], FIXTURE.map((document) => document.slug))
  assert.equal(stored.get('probe-huge-price')?.displayPriceCents, 9_999_999_999)
  assert.deepEqual(result.timings.map((timing) => timing.stage), [
    '读取现有索引与别名',
    '建索引',
    '读取 MySQL 快照',
    'bulk 导入',
    'refresh',
    '校验映射',
    '全量校验',
    '切换别名',
    '校验别名',
    '冒烟查询',
    '删除旧物理索引',
  ])
})

test('可配置物理索引前缀：命名与扫描都在隔离前缀内，默认 products_v 不变', async () => {
  const indexPrefix = 'products_es_test_rebuild_v'
  const adapter = new RecordingProductIndexAdapter({ indexPrefix })

  const result = await rebuildProductIndex(adapter, {
    loadSnapshot: async () => FIXTURE,
    alias: ALIAS,
    indexPrefix,
  })

  assert.equal(result.index, 'products_es_test_rebuild_v1')
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_es_test_rebuild_v1'])
  assert.equal(adapter.indices.has('products_es_test_rebuild_v1'), true)
  assert.equal(adapter.indices.has('products_v1'), false, '不得在默认前缀下创建索引')
})

test('bulk 逐项失败时中止，且不切换别名', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.bulkErrorIds.add('keychron-k8')

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /bulk 写入失败/)
    assert.match(error.message, /未切换别名/)
    assert.match(error.message, /新索引已清理/)
    return true
  })

  assert.equal(adapter.steps.some((step) => step.name === 'updateAlias'), false)
  assert.equal(adapter.aliases.has(ALIAS), false)
  assert.equal(adapter.indices.has('products_v1'), false)
})

test('全量校验发现字段不一致时中止，且不切换别名', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.corruptDocument = (document) => document.slug === 'keychron-k8'
    ? { ...document, displayPriceCents: document.displayPriceCents + 1 }
    : document

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /displayPriceCents 与 MySQL 不一致/)
    assert.match(error.message, /未切换别名/)
    return true
  })

  assert.equal(adapter.steps.some((step) => step.name === 'updateAlias'), false)
  assert.equal(adapter.aliases.has(ALIAS), false)
  assert.equal(adapter.indices.has('products_v1'), false)
})

test('连续重建两次：文档内容一致，别名指向新版本并删除旧索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  const first = await run(adapter)
  const firstDocuments = [...(adapter.indices.get(first.index) ?? new Map()).entries()]

  const second = await run(adapter)

  assert.equal(first.index, 'products_v1')
  assert.equal(second.index, 'products_v2')
  assert.equal(second.documentCount, first.documentCount)
  assert.deepEqual(second.previousIndices, ['products_v1'])
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v2'])
  assert.equal(adapter.indices.has('products_v1'), false)
  assert.deepEqual(second.deletedIndices, ['products_v1'])
  assert.deepEqual([...(adapter.indices.get('products_v2') ?? new Map()).entries()], firstDocuments)

  const aliasSteps = adapter.steps.filter((step) => step.name === 'updateAlias')
  assert.equal(aliasSteps.length, 2)
  const secondSwitch = aliasSteps[1]
  assert.equal(secondSwitch?.name, 'updateAlias')
  if (secondSwitch?.name !== 'updateAlias') throw new Error('缺少第二次 updateAlias')
  assert.deepEqual(secondSwitch.add, ['products_v2'])
  assert.deepEqual(secondSwitch.remove, ['products_v1'])
})

test('切换别名后冒烟查询失败时回滚到旧索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await run(adapter)
  adapter.smokeTotal = 0

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /冒烟查询没有命中/)
    return true
  })

  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'])
  assert.equal(adapter.indices.has('products_v2'), false)
})

test('切换别名后失败且回滚失败时，保留别名仍指向的新索引并提示人工检查', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await run(adapter)
  adapter.smokeTotal = 0
  adapter.aliasUpdateFailure = ({ add, remove }) =>
    add.includes('products_v1') && remove.includes('products_v2')
      ? new Error('模拟的回滚失败')
      : undefined

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /冒烟查询没有命中/)
    assert.match(error.message, /别名回滚失败/)
    assert.match(error.message, /请人工检查别名/)
    assert.match(error.message, /仍被别名 .* 引用，已保留/)
    return true
  })

  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex' && step.index === 'products_v2'),
    false,
    '别名仍指向新索引时不得删除它',
  )
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v2'])
  assert.equal(adapter.indices.has('products_v2'), true, '新索引必须保留，供人工处理')
})

/**
 * P1-B（本轮复审）：切换请求已经发出，但调用方超时/异常，复查时服务端尚未生效。
 * 此时不能把「复查显示未引用」当成「切换没有发生」——迟到的切换可能随后生效。
 */
test('P1-B：切换请求发出后失败、复查仍显示旧索引时，保留新索引并说明结果不确定', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await run(adapter)

  adapter.aliasUpdateFailure = ({ add, remove }) =>
    add.includes('products_v2') && remove.includes('products_v1')
      ? new Error('模拟的别名切换超时')
      : undefined

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的别名切换超时/)
    assert.match(error.message, /切换结果不确定/)
    assert.match(error.message, /已保留/)
    return true
  })

  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'], '复查时别名仍指向旧索引')
  assert.equal(adapter.indices.has('products_v2'), true, '切换结果不确定时新索引必须保留')
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex' && step.index === 'products_v2'),
    false,
    '切换请求已发出但结果不明时不得调用 deleteIndex',
  )
})

test('P1-B：切换从未发出就失败时，可安全清理自己创建的新索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.bulkErrorIds.add('keychron-k8')

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /未切换别名/)
    assert.match(error.message, /新索引已清理/)
    return true
  })

  assert.equal(
    adapter.steps.some((step) => step.name === 'updateAlias'),
    false,
    'bulk 失败发生在切换之前，不应发出切换请求',
  )
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex' && step.index === 'products_v1'),
    true,
    '从未发出切换请求时可以安全删除自己创建的新索引',
  )
  assert.equal(adapter.indices.has('products_v1'), false)
})

/**
 * 模拟「服务端已完成别名切换，但调用方收到异常」（P1-A）：
 * 先真正应用 add/remove，再抛错，复现「已生效但响应丢失」。
 */
class AppliedThenFailedAliasAdapter extends RecordingProductIndexAdapter {
  /** 为 true 时，切换抛错后的别名核对也失败，模拟状态未知。 */
  failAliasQueryAfterUpdate = false
  private aliasQueryFailurePending = false

  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    await super.updateAlias(alias, add, remove)
    if (this.failAliasQueryAfterUpdate) this.aliasQueryFailurePending = true
    throw new Error('模拟的响应丢失：别名切换已生效但调用方未收到响应')
  }

  override async aliasIndices (alias: string): Promise<string[]> {
    if (this.aliasQueryFailurePending) {
      this.aliasQueryFailurePending = false
      throw new Error('模拟的别名查询超时')
    }
    return super.aliasIndices(alias)
  }
}

test('P1-A：别名切换已生效但调用抛异常时，保留仍被别名引用的新索引', async () => {
  const adapter = new AppliedThenFailedAliasAdapter()

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的响应丢失/)
    assert.match(error.message, /仍被别名 products_test 引用，已保留/)
    assert.doesNotMatch(error.message, /未切换别名/)
    return true
  })

  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'], '别名目标仍应是新索引')
  assert.equal(adapter.indices.has('products_v1'), true, '仍被别名引用的新索引不得删除')
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '不得删除新索引',
  )
  assert.equal(
    adapter.steps.filter((step) => step.name === 'aliasIndices').length,
    2,
    'catch 必须重新核对别名，不能依赖本地的 aliasSwitched',
  )
})

test('P1-A：别名状态查询失败时视为未知，保留新索引并说明无法确认', async () => {
  const adapter = new AppliedThenFailedAliasAdapter()
  adapter.failAliasQueryAfterUpdate = true

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /别名状态未知/)
    assert.match(error.message, /无法确认/)
    assert.match(error.message, /已保留/)
    return true
  })

  assert.equal(adapter.indices.has('products_v1'), true, '状态未知时不得删除新索引')
  assert.equal(
    adapter.steps.filter((step) => step.name === 'deleteIndex').length,
    0,
    '状态未知时不得调用 deleteIndex',
  )
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'])
})

/**
 * P2（本轮复审）：两次重建可能选中同一版本号（max+1 非原子）。
 * 先创建成功的一方，其索引不得被创建失败的一方在异常清理里删掉。
 */
test('P2：版本冲突时重新取号并重试，且不清理不属于自己的索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.firstCreateConflict = true

  const result = await run(adapter)

  assert.equal(result.index, 'products_v2', '冲突后应按 max+1 重新取号')
  assert.deepEqual(
    adapter.steps.flatMap((step) => (step.name === 'createIndex' ? [step.index] : [])),
    ['products_v1', 'products_v2'],
    '首次冲突后应重新取号再建一次',
  )
  assert.equal(adapter.indices.has('products_v1'), true, '别人创建的 products_v1 不得删除')
  assert.equal(adapter.indices.has('products_v2'), true)
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '版本冲突不得触发任何索引清理',
  )
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v2'])
})

test('P2：建索引失败即中止，不继续 bulk，也不清理未创建的索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.createIndexFailure = (index) =>
    index === 'products_v1' ? new Error('模拟的建索引失败') : undefined

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的建索引失败/)
    assert.match(error.message, /不是由本次重建创建/)
    return true
  })

  assert.equal(
    adapter.steps.some((step) => step.name === 'bulk'),
    false,
    '建索引失败后不得继续 bulk（否则 ES 会自动建索引）',
  )
  assert.equal(adapter.steps.some((step) => step.name === 'updateAlias'), false)
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '未创建成功时不得调用 deleteIndex',
  )
})

test('P2：目标索引 mapping 与契约不符时失败，不切换别名', async () => {
  const adapter = new RecordingProductIndexAdapter()
  adapter.mappingOverrides = { name: { type: 'text', analyzer: 'smartcn' } }

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /映射与契约不一致/)
    assert.match(error.message, /name/)
    return true
  })

  assert.equal(
    adapter.steps.some((step) => step.name === 'updateAlias'),
    false,
    '映射校验失败时不得切换别名',
  )
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], [])
  assert.deepEqual(
    adapter.steps.flatMap((step) => (step.name === 'deleteIndex' ? [step.index] : [])),
    ['products_v1'],
    '只清理本次重建自己创建的索引',
  )
  assert.equal(adapter.indices.has('products_v1'), false)
})
