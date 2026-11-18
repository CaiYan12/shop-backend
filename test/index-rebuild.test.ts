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
    '全量校验',
    '切换别名',
    '校验别名',
    '冒烟查询',
    '删除旧物理索引',
  ])
})

test('bulk 返回 200 但逐项失败时中止，且不切换别名', async () => {
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
