import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { createApp, type AppInstance } from '../src/app.ts'
import type { Database } from '../src/db/client.ts'
import {
  SearchUnavailableError,
  type ProductSearchAdapter,
  type ProductSearchResult,
  type ProductSuggestionResult,
} from '../src/search/product-search.ts'
import type { ErrorBody } from './helpers/api-types.ts'
import { FakeProductSearchAdapter } from './helpers/fake-search-adapter.ts'
import { closeSeededApp, createSeededApp, type SeededApp } from './helpers/seeded-app.ts'
import { TestClock } from './helpers/test-clock.ts'
import { loadTestConfig } from './helpers/test-config.ts'

/**
 * 搜索降级冷却（#24）的默认套件：断言只落在 HTTP 响应与搜索端口的调用记录上，
 * 不测冷却的内部字段。计时走注入的假时钟（test/helpers/test-clock.ts），不真等 5 秒。
 *
 * 冷却状态归应用实例所有，因此每个用例用同一个已迁移 / 已种子的数据库句柄
 * 新建一个应用实例，用例之间互不影响。
 */

const config = loadTestConfig()

let fixture: SeededApp
let pool: Pool
let db: Database
const openedApps: AppInstance[] = []

before(async () => {
  fixture = await createSeededApp()
  pool = fixture.pool
  db = fixture.db
})

after(async () => {
  for (const app of openedApps) await app.close()
  await closeSeededApp({ pool, app: fixture.app })
})

/** 新建一个应用实例：冷却窗口用注入的时钟，窗口长度取生产默认值（5 s）。 */
async function makeApp (search: ProductSearchAdapter, clock: TestClock): Promise<AppInstance> {
  const app = await createApp({ db, config, search, searchCooldown: { now: clock.now } })
  await app.ready()
  openedApps.push(app)
  return app
}

interface HttpResult {
  status: number
  body: (Record<string, unknown> & ErrorBody)
}

async function get (app: AppInstance, url: string): Promise<HttpResult> {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() }
}

function keywordUrl (keyword: string): string {
  return `/api/products?keyword=${encodeURIComponent(keyword)}`
}

function suggestionUrl (prefix: string): string {
  return `/api/products/suggestions?q=${encodeURIComponent(prefix)}`
}

test('可用性故障开窗：窗口内关键词搜索与商品联想都直接 503，不再触达适配器', async () => {
  const clock = new TestClock()
  const search = new FakeProductSearchAdapter()
  const app = await makeApp(search, clock)
  search.failUnavailable()

  // 首个失败请求真正触达适配器，并把窗口打开。
  const first = await get(app, keywordUrl('耳机'))
  assert.equal(first.status, 503)
  assert.equal(first.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.queries.length, 1, '首次失败请求应真正触达适配器')

  // 窗口内（同一时钟、未推进）的第二个关键词请求：直接 503，不再触达适配器。
  const second = await get(app, keywordUrl('耳机'))
  assert.equal(second.status, 503)
  assert.equal(second.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.queries.length, 1, '窗口内的关键词请求不应再触达适配器')

  // 商品联想与关键词搜索共用同一个窗口。
  const suggestion = await get(app, suggestionUrl('耳'))
  assert.equal(suggestion.status, 503)
  assert.equal(suggestion.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.suggestionQueries.length, 0, '窗口内的联想请求不应触达适配器')

  // 普通浏览不经过搜索端口，冷却期间照常可用。
  const browse = await get(app, '/api/products')
  assert.equal(browse.status, 200, '搜索降级不应影响普通浏览')
  assert.equal(browse.body.total, 16)
})

test('窗口到期只放行一次恢复探测：探测失败续开 5 秒，其余请求继续直接 503', async () => {
  const clock = new TestClock()
  const search = new FakeProductSearchAdapter()
  const app = await makeApp(search, clock)
  search.failUnavailable()

  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 1, '首次失败请求应真正触达适配器')

  clock.advance(4_999)
  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 1, '窗口未到期时不应触达适配器')

  clock.advance(1)
  const probe = await get(app, keywordUrl('耳机'))
  assert.equal(probe.status, 503)
  assert.equal(search.queries.length, 2, '窗口到期后的第一个请求应真正探测')

  const afterProbe = await get(app, keywordUrl('耳机'))
  assert.equal(afterProbe.status, 503)
  assert.equal(search.queries.length, 2, '探测失败后应续开窗口，不再触达适配器')

  clock.advance(4_999)
  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 2, '续开的窗口同样按 5 秒计')
  clock.advance(1)
  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 3, '续开窗口到期后再次探测')
})

test('恢复探测成功即恢复服务：窗口关闭后请求照常返回 200', async () => {
  const clock = new TestClock()
  const search = new FakeProductSearchAdapter()
  const app = await makeApp(search, clock)
  search.failUnavailable()

  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 1, '首次失败请求应真正触达适配器')

  search.reset()
  clock.advance(5_000)
  const recovered = await get(app, keywordUrl('耳机'))
  assert.equal(recovered.status, 200, '探测成功应立刻恢复服务')
  assert.equal(search.queries.length, 1, '恢复由探测请求本身完成')

  await get(app, keywordUrl('耳机'))
  assert.equal(search.queries.length, 2, '恢复后不再进冷却，每次请求都触达适配器')
})

test('参数错误（400）与程序错误（500）都不开窗，400 仍先于 503', async () => {
  const clock = new TestClock()

  const rangeSearch = new FakeProductSearchAdapter()
  const rangeApp = await makeApp(rangeSearch, clock)
  rangeSearch.failUnavailable()

  const badRange = await get(
    rangeApp,
    `${keywordUrl('耳机')}&priceMinCents=20000&priceMaxCents=10000`,
  )
  assert.equal(badRange.status, 400)
  assert.equal(badRange.body.error.code, 'VALIDATION_FAILED')
  assert.equal(rangeSearch.queries.length, 0, '参数错误不应触达适配器')

  const unavailable = await get(rangeApp, keywordUrl('耳机'))
  assert.equal(unavailable.status, 503)
  assert.equal(rangeSearch.queries.length, 1, '400 没有开窗：合法请求仍会触达适配器')

  // 冷却窗口已打开：参数错误仍应先报 400，而不是 503（既有次序保持不变）。
  const badRangeInWindow = await get(
    rangeApp,
    `${keywordUrl('耳机')}&priceMinCents=20000&priceMaxCents=10000`,
  )
  assert.equal(badRangeInWindow.status, 400, '冷却期间参数错误仍先报 400')
  assert.equal(rangeSearch.queries.length, 1)

  const missingQ = await get(rangeApp, '/api/products/suggestions')
  assert.equal(missingQ.status, 400, '冷却期间联想缺参仍先报 400')
  assert.equal(rangeSearch.suggestionQueries.length, 0)

  // 程序错误（500）：不开窗，下一次请求仍会触达适配器。
  const failingSearch = new FakeProductSearchAdapter()
  const failingApp = await makeApp(failingSearch, clock)
  failingSearch.failure = new Error('模拟的程序错误')

  const programError = await get(failingApp, keywordUrl('耳机'))
  assert.equal(programError.status, 500)
  assert.equal(programError.body.error.code, 'INTERNAL_ERROR')

  failingSearch.failUnavailable()
  const afterProgramError = await get(failingApp, keywordUrl('耳机'))
  assert.equal(afterProgramError.status, 503)
  assert.equal(failingSearch.queries.length, 2, '500 没有开窗：下一次请求仍会触达适配器')
})

test('冷却状态按应用实例管理：一个实例开窗不影响另一个实例', async () => {
  const clock = new TestClock()
  const search = new FakeProductSearchAdapter()
  const appA = await makeApp(search, clock)
  const appB = await makeApp(search, clock)
  search.failUnavailable()

  await get(appA, keywordUrl('耳机'))
  assert.equal(search.queries.length, 1)
  await get(appA, keywordUrl('耳机'))
  assert.equal(search.queries.length, 1, 'A 的窗口内不再触达适配器')

  const fromB = await get(appB, keywordUrl('耳机'))
  assert.equal(fromB.status, 503)
  assert.equal(search.queries.length, 2, '冷却不跨应用实例共享：B 仍会真正探测')

  await get(appB, keywordUrl('耳机'))
  assert.equal(search.queries.length, 2, 'B 自己的窗口同样生效')
})

/**
 * 挂起型假适配器：用于构造「探测进行中」的并发场景。
 * `block` 为 true 时，调用会停在网关处，直到 `release()`。
 */
class BlockingSearchAdapter implements ProductSearchAdapter {
  searchCalls = 0
  suggestionCalls = 0
  failure: Error | undefined = undefined
  block = false
  private enteredResolve: (() => void) | undefined = undefined
  private releaseResolve: (() => void) | undefined = undefined
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve })
  private readonly gate = new Promise<void>((resolve) => { this.releaseResolve = resolve })

  release (): void {
    this.releaseResolve?.()
  }

  private async hold (): Promise<void> {
    if (!this.block) return
    this.enteredResolve?.()
    await this.gate
  }

  async search (): Promise<ProductSearchResult> {
    this.searchCalls += 1
    await this.hold()
    if (this.failure !== undefined) throw this.failure
    return { total: 0, productIds: [], highlights: new Map() }
  }

  async suggest (): Promise<ProductSuggestionResult> {
    this.suggestionCalls += 1
    await this.hold()
    if (this.failure !== undefined) throw this.failure
    return { items: [] }
  }
}

test('探测进行中只允许一个请求真正执行，其余并发请求照常 503', async () => {
  const clock = new TestClock()
  const search = new BlockingSearchAdapter()
  const app = await makeApp(search, clock)
  search.failure = new SearchUnavailableError('模拟的搜索服务连接失败。')

  await get(app, keywordUrl('耳机'))
  assert.equal(search.searchCalls, 1, '首次失败请求应真正触达适配器')

  clock.advance(5_000)
  search.block = true
  const probe = get(app, keywordUrl('耳机'))
  await search.entered
  assert.equal(search.searchCalls, 2, '窗口到期后的第一个请求应真正探测')

  // 探测还在进行中：并发请求不应再触达适配器，应立即 503。
  const intruder = get(app, keywordUrl('耳机'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(search.searchCalls, 2, '探测进行中只允许一个真正执行')

  search.release()
  const [probeResult, intruderResult] = await Promise.all([probe, intruder])
  assert.equal(probeResult.status, 503)
  assert.equal(intruderResult.status, 503)
  assert.equal(intruderResult.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.searchCalls, 2, '并发请求自始至终没有触达适配器')
})

/**
 * 迟到成功响应（P2）：第一次搜索在开窗前发出并挂起，第二次搜索触发可用性故障开窗；
 * 释放第一次搜索后它返回成功。这个成功属于旧窗口代次，不能关闭新开的窗口。
 */
class LateSuccessSearchAdapter implements ProductSearchAdapter {
  searchCalls = 0
  suggestionCalls = 0
  private enteredResolve: (() => void) | undefined = undefined
  private releaseResolve: (() => void) | undefined = undefined
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve })
  private readonly gate = new Promise<void>((resolve) => { this.releaseResolve = resolve })

  release (): void {
    this.releaseResolve?.()
  }

  async search (): Promise<ProductSearchResult> {
    this.searchCalls += 1
    if (this.searchCalls === 1) {
      this.enteredResolve?.()
      await this.gate
      return { total: 0, productIds: [], highlights: new Map() }
    }
    throw new SearchUnavailableError('模拟的搜索服务连接失败。')
  }

  async suggest (): Promise<ProductSuggestionResult> {
    this.suggestionCalls += 1
    return { items: [] }
  }
}

test('P2：开窗前发出的请求迟到成功，不得关闭此后建立的冷却窗口', async () => {
  const clock = new TestClock(0)
  const search = new LateSuccessSearchAdapter()
  const app = await makeApp(search, clock)

  // A 在开窗前发出，挂在适配器里。
  const late = get(app, keywordUrl('耳机'))
  await search.entered
  assert.equal(search.searchCalls, 1, 'A 已触达适配器并挂起')

  // B 触发可用性故障，打开 5 秒窗口。
  const openWindow = await get(app, keywordUrl('耳机'))
  assert.equal(openWindow.status, 503)
  assert.equal(openWindow.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.searchCalls, 2, 'B 触达适配器并开窗')

  // 时钟只前进 1 ms，随后 A 才返回成功。
  clock.advance(1)
  search.release()
  const lateResult = await late
  assert.equal(lateResult.status, 200, 'A 本身仍按成功返回')

  // 窗口必须仍在：联想直接 503，且没有触达适配器。
  const suggestion = await get(app, suggestionUrl('耳'))
  assert.equal(suggestion.status, 503, '迟到的成功不得清掉刚建立的冷却窗口')
  assert.equal(suggestion.body.error.code, 'SEARCH_NOT_AVAILABLE')
  assert.equal(search.suggestionCalls, 0, '窗口内的联想请求不得触达适配器')
})
