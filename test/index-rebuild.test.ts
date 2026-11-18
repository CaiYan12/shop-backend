import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AliasExclusivityError,
  IndexRebuildError,
  rebuildProductIndex,
  selectAliasRestoreTarget,
  settleAliasExclusiveTarget,
} from '../src/search/index-rebuild.ts'
import { RebuildLockError } from '../src/search/rebuild-lock.ts'
import type { ProductSearchDocument } from '../src/search/product-snapshot.ts'
import { freePort } from './helpers/free-port.ts'
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

/**
 * 默认套件不碰仓库 .run 的真实身份记录：每次运行用独立的临时目录。
 * 互斥端口用 freePort() 取高位空闲端口，避免与其它用例或本机服务冲突。
 */
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'shop-rebuild-lock-'))
const OWNER_PATH = join(LOCK_DIR, 'es-rebuild.owner.json')
after(() => rmSync(LOCK_DIR, { recursive: true, force: true }))

async function run (adapter: RecordingProductIndexAdapter) {
  return rebuildProductIndex(adapter, {
    loadSnapshot: async () => FIXTURE,
    alias: ALIAS,
    lockPort: await freePort(),
    ownerPath: OWNER_PATH,
    settleMs: 0,
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
    'aliasIndices',
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
    '别名预收敛',
    '切换别名',
    '静默与别名收敛',
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
    lockPort: await freePort(),
    ownerPath: OWNER_PATH,
    settleMs: 0,
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

test('切换别名后冒烟查询失败：回滚到旧索引，但按新规则保留新索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await run(adapter)
  adapter.smokeTotal = 0

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /冒烟查询没有命中/)
    assert.match(error.message, /别名已回滚/)
    assert.match(error.message, /尝试过切换就不删除/)
    assert.match(error.message, /products_v2/)
    return true
  })

  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'])
  assert.equal(adapter.indices.has('products_v2'), true, '尝试过切换后新索引必须保留')
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex' && step.index === 'products_v2'),
    false,
    '回滚成功也不得删除新索引',
  )
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
    3,
    '初始读取、建前收敛与 catch 复查各一次（不能依赖本地的 aliasSwitched）',
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
/**
 * 模拟「切换成功后别名同时指向两个索引」（第三轮复审）：
 * 另一个重建也把自己的索引 add 进了同一别名。注入走真实的 updateAlias，
 * 不直接改内部状态，保证重建看到的是端口返回的实际目标。
 */
class MultiTargetAliasAdapter extends RecordingProductIndexAdapter {
  extraTarget = 'products_v9'
  convergenceFailure?: Error
  ignoreConvergence = false

  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    const isConvergence = add.length === 0 && remove.length > 0
    if (isConvergence) {
      if (this.convergenceFailure !== undefined) {
        this.steps.push({ name: 'updateAlias', alias, add: [...add], remove: [...remove] })
        throw this.convergenceFailure
      }
      if (this.ignoreConvergence) {
        this.steps.push({ name: 'updateAlias', alias, add: [...add], remove: [...remove] })
        return
      }
      await super.updateAlias(alias, add, remove)
      return
    }
    await super.updateAlias(alias, add, remove)
    // 切换成功后，另一个重建的 add 也生效：别名出现两个目标。
    if (add.length > 0) await super.updateAlias(alias, [this.extraTarget], [])
  }
}


test('切换后别名出现两个目标：先收敛为唯一目标，重建继续成功', async () => {
  const adapter = new MultiTargetAliasAdapter()
  const result = await run(adapter)

  assert.equal(result.index, 'products_v1')
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? new Set<string>())], ['products_v1'])

  const aliasSteps = adapter.steps.filter((step) => step.name === 'updateAlias')
  const convergence = aliasSteps.at(-1)
  assert.equal(convergence?.name, 'updateAlias')
  if (convergence?.name !== 'updateAlias') throw new Error('缺少收敛用的 updateAlias')
  assert.deepEqual(convergence.add, [], '收敛只移除多余目标，不能再 add')
  assert.deepEqual(convergence.remove, ['products_v9'], '一次请求移除全部多余目标')
  assert.equal(
    adapter.steps.filter((step) => step.name === 'aliasIndices').length,
    4,
    '初始读取、建前收敛、切换后复查、收敛后再复查各一次',
  )
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '收敛只改别名，不删除任何索引',
  )
})

test('收敛后仍有两个目标：失败、不删除任何索引，并报告实际目标', async () => {
  const adapter = new MultiTargetAliasAdapter()
  adapter.ignoreConvergence = true

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof AliasExclusivityError)
    assert.match(error.message, /别名目标不唯一/)
    assert.match(error.message, /products_v1/)
    assert.match(error.message, /products_v9/)
    assert.match(error.message, /未删除任何索引/)
    return true
  })

  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '唯一目标不变式失败时不得删除任何索引',
  )
  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? new Set<string>())].sort(),
    ['products_v1', 'products_v9'],
    '保留现场供人工核对：别名仍是两个目标',
  )
})

test('收敛请求失败：失败并报告当前目标，不删除任何索引', async () => {
  const adapter = new MultiTargetAliasAdapter()
  adapter.convergenceFailure = new Error('模拟的收敛请求失败')

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof AliasExclusivityError)
    assert.match(error.message, /模拟的收敛请求失败/)
    assert.match(error.message, /products_v1/)
    assert.match(error.message, /products_v9/)
    assert.match(error.message, /未删除任何索引/)
    return true
  })

  assert.equal(adapter.steps.some((step) => step.name === 'deleteIndex'), false)
  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? new Set<string>())].sort(),
    ['products_v1', 'products_v9'],
  )
})

test('并发：同一互斥端口下两个重建只有一个成功，另一个立即失败', async () => {
  const adapter = new RecordingProductIndexAdapter()
  const lockPort = await freePort()
  const ownerFile = join(LOCK_DIR, 'concurrent.owner.json')
  const options = {
    loadSnapshot: async () => FIXTURE,
    alias: ALIAS,
    lockPort,
    ownerPath: ownerFile,
    settleMs: 0,
  }

  // 第一次调用在返回 Promise 前已发起端口监听；第二次立刻看到 EADDRINUSE。
  const first = rebuildProductIndex(adapter, options)
  const second = rebuildProductIndex(adapter, options)
  const outcomes = await Promise.allSettled([first, second])

  assert.equal(outcomes[0]?.status, 'fulfilled', '先取得互斥的重建应成功')
  assert.equal(outcomes[1]?.status, 'rejected', '第二个重建必须因端口占用失败')
  const rejection = outcomes[1]?.status === 'rejected' ? outcomes[1].reason : undefined
  assert.ok(rejection instanceof RebuildLockError)
  assert.ok(
    rejection.message.includes('127.0.0.1:' + String(lockPort)),
    '错误消息必须指出互斥端口',
  )
  assert.ok(
    rejection.message.includes('netstat -ano | findstr :' + String(lockPort)),
    '错误消息必须给出排查命令',
  )

  const result = outcomes[0]?.status === 'fulfilled' ? outcomes[0].value : undefined
  assert.ok(result !== undefined)
  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? new Set<string>())],
    [result.index],
    '成功者结束后别名恰好一个目标',
  )
  assert.equal(existsSync(ownerFile), false, '重建结束后必须删除诊断记录')
  assert.equal(adapter.indices.size, 1, '失败方不得创建索引')
})

test('建前收敛：别名多目标时收敛到版本号最大的现存索引，再继续重建', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await adapter.createIndex('products_v1')
  await adapter.createIndex('products_v2')
  await adapter.updateAlias(ALIAS, ['products_v1', 'products_v2'], [])
  adapter.steps.length = 0

  const result = await run(adapter)

  assert.equal(result.index, 'products_v3')
  assert.deepEqual(result.previousIndices, ['products_v2'], '切换时只移除收敛后的实际目标')
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v3'])

  const aliasSteps = adapter.steps.filter((step) => step.name === 'updateAlias')
  assert.equal(aliasSteps.length, 2, '一次建前收敛 + 一次切换')
  const convergence = aliasSteps[0]
  assert.equal(convergence?.name, 'updateAlias')
  if (convergence?.name !== 'updateAlias') throw new Error('缺少建前收敛的 updateAlias')
  assert.deepEqual(convergence.add, [])
  assert.deepEqual(convergence.remove, ['products_v1'], '只移除版本号较小的目标')
  assert.deepEqual(result.deletedIndices, ['products_v2'], '只删除被替换的旧目标')
  assert.equal(adapter.indices.has('products_v1'), true, '收敛只改别名，不删除索引')
})

test('发布后静默窗口：迟到的旧目标在静默期间加回，复查后收敛为唯一目标', async () => {
  const adapter = new RecordingProductIndexAdapter()
  let injected = false

  const result = await rebuildProductIndex(adapter, {
    loadSnapshot: async () => FIXTURE,
    alias: ALIAS,
    lockPort: await freePort(),
    ownerPath: OWNER_PATH,
    settleMs: 5,
    sleep: async () => {
      if (injected) return
      injected = true
      // 模拟另一个进程在静默窗口内迟到地 add 一个旧目标。
      await adapter.updateAlias(ALIAS, ['products_v9'], [])
    },
  })

  assert.equal(result.index, 'products_v1')
  assert.equal(injected, true, '静默窗口必须被调用')
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v1'])
  const aliasSteps = adapter.steps.filter((step) => step.name === 'updateAlias')
  const convergence = aliasSteps.at(-1)
  assert.equal(convergence?.name, 'updateAlias')
  if (convergence?.name !== 'updateAlias') throw new Error('缺少收敛用的 updateAlias')
  assert.deepEqual(convergence.remove, ['products_v9'])
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '静默收敛只改别名，不删除任何索引',
  )
})

/**
 * 模拟「收敛请求成功后，下一次复查 aliasIndices 抛一般错误」：
 * 旧实现在这里会回滚并删除新索引；新规则只允许保留。
 */
class RecheckAfterConvergeFailureAdapter extends RecordingProductIndexAdapter {
  private converged = false

  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    await super.updateAlias(alias, add, remove)
    if (add.length > 0) {
      // 切换成功后，另一个重建的迟到 add 让别名出现第二个目标。
      await super.updateAlias(alias, ['products_v9'], [])
      return
    }
    if (remove.includes('products_v9')) this.converged = true
  }

  override async aliasIndices (alias: string): Promise<string[]> {
    if (this.converged) {
      this.converged = false
      throw new Error('模拟的收敛后复查失败')
    }
    return await super.aliasIndices(alias)
  }
}

/**
 * 首次发布（previousIndices 为空）时，收敛后的复查若抛一般错误，旧实现会走回滚：
 * updateAlias(alias, [], [products_v1]) 把唯一目标也移除，别名零目标、关键词接口 503。
 * 修复后首次发布不回滚，别名继续指向新索引；错误消息要说明别名当前指向哪里。
 */
test('首次发布后复查异常：别名保持指向新索引，且从未发起移除新索引的别名请求', async () => {
  const adapter = new RecheckAfterConvergeFailureAdapter()

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的收敛后复查失败/)
    assert.match(error.message, /products_v1/)
    assert.match(error.message, /别名 products_test 当前指向 products_v1/)
    assert.doesNotMatch(error.message, /别名已回滚/)
    return true
  })

  assert.equal(adapter.indices.has('products_v1'), true, '新索引必须保留')
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '尝试过切换后任何异常路径都不得调用 deleteIndex',
  )
  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? [])],
    ['products_v1'],
    '首次发布没有旧索引，失败后别名仍必须指向新索引',
  )
  assert.deepEqual(
    adapter.steps.filter(
      (step) => step.name === 'updateAlias' && step.remove.includes('products_v1'),
    ),
    [],
    '首次发布失败不得发起移除新索引的别名请求',
  )
})

/**
 * 模拟回滚请求「只生效了 remove 新索引，add 旧索引未落地」：别名被撤空。
 * 这正是 P1 的停服形态；修复后必须在 catch 里复查并立即恢复。
 */
class RollbackEmptiesAliasAdapter extends RecordingProductIndexAdapter {
  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    if (add.includes('products_v1') && remove.includes('products_v2')) {
      await super.updateAlias(alias, [], remove)
      throw new Error('模拟的回滚响应丢失')
    }
    await super.updateAlias(alias, add, remove)
  }
}

test('回滚把别名撤空时立即恢复旧索引，并在消息里说明已恢复', async () => {
  const adapter = new RollbackEmptiesAliasAdapter()
  await run(adapter)
  adapter.smokeTotal = 0

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的回滚响应丢失/)
    assert.match(error.message, /恢复为现存旧索引 products_v1/)
    assert.match(error.message, /已恢复别名，避免零目标/)
    assert.match(error.message, /别名 products_test 当前指向 products_v1/)
    return true
  })

  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? [])],
    ['products_v1'],
    '零目标必须立即恢复为旧索引',
  )
  assert.equal(adapter.indices.has('products_v2'), true, '新索引仍按规则保留')
})

/**
 * 模拟真实 ES：add 一个不存在的物理索引会报 index_not_found。
 * 同时允许在冒烟查询时模拟外部进程删除索引并撤空别名（P1 第六轮复审的复现条件）。
 */
class MissingIndexAwareAliasAdapter extends RecordingProductIndexAdapter {
  externalWipe?: { indices: string[], alias: string }
  successfulAdds: string[][] = []

  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    this.steps.push({ name: 'updateAlias', alias, add: [...add], remove: [...remove] })
    const missing = add.filter((index) => !this.indices.has(index))
    if (missing.length > 0) {
      throw new Error(`模拟的 index_not_found_exception：${missing.join('、')}`)
    }
    const targets = this.aliases.get(alias) ?? new Set<string>()
    for (const index of remove) targets.delete(index)
    for (const index of add) targets.add(index)
    if (targets.size === 0) this.aliases.delete(alias)
    else this.aliases.set(alias, targets)
    if (add.length > 0) this.successfulAdds.push([...add])
  }

  override async searchTotal (index: string): Promise<number> {
    const wipe = this.externalWipe
    if (wipe !== undefined) {
      this.externalWipe = undefined
      for (const name of wipe.indices) this.indices.delete(name)
      this.aliases.delete(wipe.alias)
      return 0
    }
    return super.searchTotal(index)
  }
}

test('恢复分支：旧索引已被外部删除时恢复新索引，不再 add 已删除的旧索引', async () => {
  const adapter = new MissingIndexAwareAliasAdapter()
  await run(adapter)
  adapter.steps.length = 0
  adapter.successfulAdds.length = 0
  // 外部进程：撤空别名并删掉旧索引；新索引仍然存在。
  adapter.externalWipe = { indices: ['products_v1'], alias: ALIAS }

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /冒烟查询没有命中/)
    assert.match(error.message, /旧索引 products_v1 已不存在/)
    assert.match(error.message, /恢复为新索引 products_v2/)
    assert.match(error.message, /已恢复别名，避免零目标/)
    assert.match(error.message, /别名 products_test 当前指向 products_v2/)
    return true
  })

  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? [])],
    ['products_v2'],
    '别名必须恢复到仍然存在的新索引',
  )
  assert.deepEqual(
    adapter.successfulAdds,
    [['products_v2'], ['products_v2']],
    '只有切换与恢复两次成功 add，且都只 add 现存的新索引',
  )
  assert.equal(
    adapter.steps.filter(
      (step) => step.name === 'updateAlias' && step.add.includes('products_v1'),
    ).length,
    1,
    '只允许回滚尝试 add 已删除的旧索引，恢复不得再次 add 它',
  )
  assert.equal(adapter.indices.has('products_v2'), true, '新索引必须保留')
})

/**
 * 回滚只生效了 remove 新索引、add 旧索引未落地（别名被撤空），
 * 且此时 listProductIndices 抛错：无法确认旧索引是否还在，直接恢复新索引。
 */
class ListFailureOnRecoveryAdapter extends RecordingProductIndexAdapter {
  failList = false
  armed = false

  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    if (this.failList && add.includes('products_v1') && remove.includes('products_v2')) {
      await super.updateAlias(alias, [], remove)
      throw new Error('模拟的回滚响应丢失')
    }
    await super.updateAlias(alias, add, remove)
  }

  override async listProductIndices (): Promise<string[]> {
    if (this.failList) {
      this.steps.push({ name: 'listProductIndices' })
      throw new Error('模拟的索引列表查询失败')
    }
    return super.listProductIndices()
  }

  override async searchTotal (index: string): Promise<number> {
    if (!this.armed) return super.searchTotal(index)
    this.failList = true
    return 0
  }
}

test('恢复分支：listProductIndices 抛错时视为无法确认，恢复新索引', async () => {
  const adapter = new ListFailureOnRecoveryAdapter()
  await run(adapter)
  adapter.armed = true

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /模拟的回滚响应丢失/)
    assert.match(error.message, /模拟的索引列表查询失败/)
    assert.match(error.message, /无法确认旧索引是否仍存在/)
    assert.match(error.message, /恢复为新索引 products_v2/)
    assert.match(error.message, /已恢复别名，避免零目标/)
    return true
  })

  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? [])],
    ['products_v2'],
    '无法确认旧索引时必须恢复本进程刚创建的新索引',
  )
  assert.equal(
    adapter.steps.filter(
      (step) => step.name === 'updateAlias' && step.add.includes('products_v1'),
    ).length,
    1,
    '只允许失败的回滚尝试 add 旧索引',
  )
})

test('恢复分支：恢复目标全不存在时消息写明无可用恢复目标，不抛未捕获异常', async () => {
  const adapter = new MissingIndexAwareAliasAdapter()
  await run(adapter)
  adapter.steps.length = 0
  // 外部进程把旧索引和新索引都删掉，别名也被撤空。
  adapter.externalWipe = { indices: ['products_v1', 'products_v2'], alias: ALIAS }

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /无可用恢复目标/)
    assert.doesNotMatch(error.message, /恢复失败/)
    return true
  })

  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], [], '没有可用目标时保持现场，等人工处理')
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex' && step.index === 'products_v2'),
    false,
    '尝试过切换后不得删除新索引',
  )
})

test('恢复目标选择：多个现存旧索引时取版本号最大的，并说明缺失的旧索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await adapter.createIndex('products_v7')
  await adapter.createIndex('products_v9')
  await adapter.createIndex('products_v12')
  await adapter.createIndex('products_v13')
  adapter.steps.length = 0

  const choice = await selectAliasRestoreTarget(adapter, {
    indexName: 'products_v13',
    previousIndices: ['products_v5', 'products_v7', 'products_v9', 'products_v12'],
    indexPrefix: 'products_v',
  })

  assert.equal(choice.target, 'products_v12', '多个现存旧索引时取版本号最大的')
  assert.match(choice.note, /恢复为现存旧索引 products_v12/)
  assert.match(choice.note, /旧索引 products_v5 已不存在/)
  assert.equal(
    adapter.steps.some((step) => step.name === 'deleteIndex'),
    false,
    '选择恢复目标只读，不删除索引',
  )
  assert.equal(
    adapter.steps.some((step) => step.name === 'updateAlias'),
    false,
    '选择恢复目标只读，不改别名',
  )
})

/**
 * 首次发布没有旧索引：别名被外部撤空后只能加回新索引。
 */
class ExternalEmptyAfterSwitchAdapter extends RecordingProductIndexAdapter {
  override async searchTotal (index: string): Promise<number> {
    await this.updateAlias(index, [], ['products_v1'])
    return 0
  }
}

test('首次发布中途别名被外部撤空时立即恢复新索引，避免零目标', async () => {
  const adapter = new ExternalEmptyAfterSwitchAdapter()

  await assert.rejects(run(adapter), (error: unknown) => {
    assert.ok(error instanceof IndexRebuildError)
    assert.match(error.message, /冒烟查询没有命中/)
    assert.match(error.message, /已恢复别名，避免零目标/)
    assert.match(error.message, /别名 products_test 当前指向 products_v1/)
    assert.doesNotMatch(error.message, /别名已回滚/)
    return true
  })

  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? [])],
    ['products_v1'],
    '没有旧索引时必须把新索引加回别名',
  )
  assert.equal(adapter.indices.has('products_v1'), true)
})

/** 忽略收敛请求的别名桩：用来验证轮数耗尽后的失败路径。 */
class StubbornAliasAdapter extends RecordingProductIndexAdapter {
  override async updateAlias (alias: string, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length > 0) {
      this.steps.push({ name: 'updateAlias', alias, add: [...add], remove: [...remove] })
      return
    }
    await super.updateAlias(alias, add, remove)
  }
}

test('收敛函数：别名多目标时收敛到版本号最大的现存索引，不删除索引', async () => {
  const adapter = new RecordingProductIndexAdapter()
  await adapter.createIndex('products_v1')
  await adapter.createIndex('products_v2')
  await adapter.createIndex('products_v5')
  await adapter.updateAlias(ALIAS, ['products_v1', 'products_v5', 'products_v2'], [])
  adapter.steps.length = 0

  const result = await settleAliasExclusiveTarget(adapter, {
    alias: ALIAS,
    indexPrefix: 'products_v',
    settleMs: 0,
    maxRounds: 1,
  })

  assert.equal(result.target, 'products_v5')
  assert.deepEqual([...(adapter.aliases.get(ALIAS) ?? [])], ['products_v5'])
  assert.deepEqual([...result.removed].sort(), ['products_v1', 'products_v2'])
  assert.equal(adapter.steps.some((step) => step.name === 'deleteIndex'), false)
})

test('收敛函数：收敛后仍多目标时失败且不删除任何索引', async () => {
  const adapter = new StubbornAliasAdapter()
  await adapter.createIndex('products_v1')
  await adapter.createIndex('products_v2')
  await adapter.updateAlias(ALIAS, ['products_v1', 'products_v2'], [])
  adapter.steps.length = 0

  await assert.rejects(
    settleAliasExclusiveTarget(adapter, {
      alias: ALIAS,
      indexPrefix: 'products_v',
      expectedIndex: 'products_v1',
      settleMs: 0,
      maxRounds: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AliasExclusivityError)
      assert.match(error.message, /仍不唯一/)
      assert.match(error.message, /products_v1/)
      assert.match(error.message, /products_v2/)
      return true
    },
  )
  assert.equal(adapter.steps.some((step) => step.name === 'deleteIndex'), false)
  assert.deepEqual(
    [...(adapter.aliases.get(ALIAS) ?? new Set<string>())].sort(),
    ['products_v1', 'products_v2'],
  )
})
