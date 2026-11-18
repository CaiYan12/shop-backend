import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@elastic/elasticsearch'
import type { RowDataPacket } from 'mysql2'
import type { ListItem } from '../test/helpers/api-types.ts'
import { closeSeededApp, createSeededApp, type SeededApp } from '../test/helpers/seeded-app.ts'
import {
  ElasticsearchProductIndexAdapter,
  ElasticsearchProductSearchAdapter,
} from '../src/search/elasticsearch-adapter.ts'
import { productIndexVersion } from '../src/search/index-mapping.ts'
import type { ProductSearchDocument } from '../src/search/product-snapshot.ts'
import { loadProductSnapshot } from '../src/search/product-snapshot.ts'
import {
  assertDemoIndexStateUnchanged,
  captureDemoIndexState,
  cleanupIsolatedProductIndex,
  createTestEsClient,
  resetIsolatedProductIndex,
  type DemoIndexState,
} from './helpers/es-fixture.ts'
import { TEST_ALIAS, TEST_INDEX } from './helpers/es-test-env.ts'

/**
 * 一致性验收（#25）：关键词走 Elasticsearch，展示字段回 MySQL 补齐；
 * 这里把同一条 HTTP 响应与 MySQL 侧按同一规则算出的期望逐条比对：
 * slug 顺序、total / totalPages / page / pageSize，以及共同的 11 个业务字段。
 *
 * 隔离：测试索引 products_es_test + 别名 products_es_test_alias；
 * 演示别名 products 与 products_vN 索引只做前后快照核对，不读写。
 */

interface ListItemWithHighlight extends ListItem {
  highlight?: unknown
}

interface ListBody {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: ListItemWithHighlight[]
}

type MatrixSort = 'price_asc' | 'price_desc' | 'sales_desc'

interface MatrixCase {
  name: string
  keyword: string
  category?: string
  priceMinCents?: number
  priceMaxCents?: number
  minSales?: number
  /** 省略表示相关性排序；相关性期望来自下方预先记录的命中与顺序。 */
  sort?: MatrixSort
  page: number
  pageSize: number
}

/**
 * V10 预先记录的命中与顺序（#25）。
 *
 * 预期依据：
 * - 种子清单逐件的名称 / 品牌 / 型号（不是跑完查询再倒推）；
 * - V11 已记录的分词行为（smartcn：`Apple` → appl、`A2096` → a + 2096、
 *   `机械键盘` → 机械 + 键盘、`降噪` → 降 + 噪）；
 * - 同分按 productId 升序（C49），因此 `A2096` 的 a 命中两只 A 开头型号的手表、
 *   `机械键盘` 的「键盘」多命中游戏键盘，都按已知副作用记录在预期里。
 *
 * 这些期望在验收运行前写死；实际不一致就如实失败，不为变绿放宽断言。
 */
const RELEVANCE_FIXTURES: Record<string, readonly string[]> = {
  // 必需项：固定包含 Apple A2096；airpods-max 同时命中品牌与型号，排第一。
  'Apple A2096': ['airpods-max', 'apple-watch-series-8', 'apple-watch-ultra', 'apple-earpods'],
  // 分词副作用：a 命中 A2771 / A2626 两只 watch（型号以 A 开头），多命中 2 件。
  A2096: ['airpods-max', 'apple-watch-series-8', 'apple-watch-ultra'],
  // 分词副作用：机械 + 键盘，键盘额外命中「游戏键盘」的 logitech-g15。
  机械键盘: ['logitech-g613', 'keychron-k8', 'cherry-g80-3850', 'logitech-g15'],
  降噪: ['airpods-max', 'sony-wh-1000xm3'],
  耳机: ['apple-earpods', 'sony-wh-ch500', 'airpods-max', 'sony-wh-1000xm3'],
  // 中英混合：AirPods 与 降噪/噪 分别命中。
  'AirPods 降噪': ['airpods-max', 'sony-wh-1000xm3'],
  // 品牌：4 件 Apple；品牌分词为 appl，名称字段的 BM25 长度差异决定先后。
  Apple: ['apple-earpods', 'apple-watch-ultra', 'apple-watch-series-8', 'airpods-max'],
  键盘: ['logitech-g15', 'logitech-g613', 'keychron-k8', 'cherry-g80-3850'],
}

/** 12 条一致性矩阵：关键词 × 商品类型 / 价格区间 / 销量 × 三种排序 × 分页。 */
const MATRIX_CASES: MatrixCase[] = [
  { name: 'Apple A2096 · 相关性 · 全量第一页', keyword: 'Apple A2096', page: 1, pageSize: 8 },
  { name: '机械键盘 · 相关性 · 分词副作用', keyword: '机械键盘', page: 1, pageSize: 8 },
  { name: 'Apple A2096 · 商品类型 wearables', keyword: 'Apple A2096', category: 'wearables', page: 1, pageSize: 8 },
  { name: '耳机 · 价格上限 20000 分', keyword: '耳机', priceMaxCents: 20_000, page: 1, pageSize: 8 },
  { name: '耳机 · 销量下限 2000', keyword: '耳机', minSales: 2_000, page: 1, pageSize: 8 },
  {
    name: '耳机 · 价格区间 100000–500000 分 · 价格降序',
    keyword: '耳机',
    priceMinCents: 100_000,
    priceMaxCents: 500_000,
    sort: 'price_desc',
    page: 1,
    pageSize: 8,
  },
  {
    name: '机械键盘 · 商品类型 peripherals · 销量降序',
    keyword: '机械键盘',
    category: 'peripherals',
    sort: 'sales_desc',
    page: 1,
    pageSize: 8,
  },
  {
    name: '键盘 · 商品类型 peripherals · 价格升序',
    keyword: '键盘',
    category: 'peripherals',
    sort: 'price_asc',
    page: 1,
    pageSize: 8,
  },
  { name: 'Apple · 价格降序 · 每页 2 条第 1 页', keyword: 'Apple', sort: 'price_desc', page: 1, pageSize: 2 },
  { name: 'Apple · 价格降序 · 每页 2 条第 2 页', keyword: 'Apple', sort: 'price_desc', page: 2, pageSize: 2 },
  { name: '降噪 · 销量降序', keyword: '降噪', sort: 'sales_desc', page: 1, pageSize: 8 },
  { name: '耳机 · 商品类型 displays · 空结果', keyword: '耳机', category: 'displays', page: 1, pageSize: 8 },
]

let client: Client
let seeded: SeededApp
let demoBefore: DemoIndexState
let documents: ProductSearchDocument[]

before(async () => {
  client = createTestEsClient()
  seeded = await createSeededApp({
    search: new ElasticsearchProductSearchAdapter(client, { alias: TEST_ALIAS }),
  })
  documents = await loadProductSnapshot(seeded.db)
  demoBefore = await captureDemoIndexState(client)
  await resetIsolatedProductIndex(client, TEST_INDEX, TEST_ALIAS, documents)
})

after(async () => {
  try {
    await cleanupIsolatedProductIndex(client, TEST_INDEX, TEST_ALIAS)
    assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
  } finally {
    await closeSeededApp(seeded)
    await client.close()
  }
})

async function list (query: Record<string, string | number> = {}): Promise<{
  status: number
  body: ListBody
}> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  const response = await seeded.app.inject({ method: 'GET', url: `/api/products${suffix}` })
  return { status: response.statusCode, body: response.json() as ListBody }
}

/** 高亮是关键词路径独有的附加字段；11 个业务字段的比对要排除它。 */
function businessFields (item: ListItemWithHighlight): ListItem {
  const { highlight: _highlight, ...rest } = item
  return rest
}

interface MysqlBaseline {
  bySlug: Map<string, ListItem>
  productIds: Map<string, number>
}

/** MySQL 路径（无关键词）给出的 16 件商品完整列表项；顺序无关，按 slug 取用。 */
async function loadMysqlBaseline (): Promise<MysqlBaseline> {
  const { status, body } = await list({ pageSize: 50 })
  assert.equal(status, 200, 'MySQL 浏览路径应返回 200')
  assert.equal(body.items.length, documents.length, 'MySQL 路径应返回全部种子商品')
  const bySlug = new Map(body.items.map((item) => [item.slug, businessFields(item)]))
  const [rows] = await seeded.pool.query<RowDataPacket[]>('SELECT id, slug FROM products')
  const productIds = new Map(rows.map((row) => [String(row.slug), Number(row.id)]))
  return { bySlug, productIds }
}

function matchesFilters (item: ListItem, testCase: MatrixCase): boolean {
  if (testCase.category !== undefined && item.category.slug !== testCase.category) return false
  if (testCase.priceMinCents !== undefined && item.displayPriceCents < testCase.priceMinCents) return false
  if (testCase.priceMaxCents !== undefined && item.displayPriceCents > testCase.priceMaxCents) return false
  if (testCase.minSales !== undefined && item.sales < testCase.minSales) return false
  return true
}

/** 与 MySQL 路径同一规则：价格 / 销量主排序，同值按 productId 升序（C49）。 */
function sortCompared (
  sort: MatrixSort,
  baseline: MysqlBaseline,
): (left: string, right: string) => number {
  const productId = (slug: string): number => baseline.productIds.get(slug) ?? Number.MAX_SAFE_INTEGER
  return (left, right) => {
    const a = baseline.bySlug.get(left)
    const b = baseline.bySlug.get(right)
    assert.ok(a !== undefined && b !== undefined, '期望集合中的商品必须存在于 MySQL')
    const primary = sort === 'price_asc'
      ? a.displayPriceCents - b.displayPriceCents
      : sort === 'price_desc'
        ? b.displayPriceCents - a.displayPriceCents
        : b.sales - a.sales
    return primary !== 0 ? primary : productId(left) - productId(right)
  }
}

test('一致性矩阵：12 条关键词 × 筛选 × 排序 × 分页与 MySQL 期望逐条一致', async (t) => {
  const baseline = await loadMysqlBaseline()

  for (const testCase of MATRIX_CASES) {
    await t.test(testCase.name, async () => {
      const fixture = RELEVANCE_FIXTURES[testCase.keyword]
      assert.ok(
        fixture !== undefined,
        `关键词「${testCase.keyword}」没有预先记录的命中，不能凭 ES 结果临时造期望。`,
      )

      const expectedSlugs = fixture
        .map((slug) => {
          const item = baseline.bySlug.get(slug)
          assert.ok(item !== undefined, `预先记录的命中 ${slug} 必须在 MySQL 中存在`)
          return item
        })
        .filter((item) => matchesFilters(item, testCase))
        .map((item) => item.slug)

      if (testCase.sort !== undefined) {
        expectedSlugs.sort(sortCompared(testCase.sort, baseline))
      } else {
        // 筛选不改变相关性排序的相对顺序：过滤后应与预记录顺序的前后关系一致。
        const filteredOrder = fixture.filter((slug) => expectedSlugs.includes(slug))
        assert.deepEqual(expectedSlugs, filteredOrder, `${testCase.name}：筛选不得改变相关性顺序`)
      }

      const total = expectedSlugs.length
      const totalPages = total === 0 ? 0 : Math.ceil(total / testCase.pageSize)
      const start = (testCase.page - 1) * testCase.pageSize
      const expectedPage = expectedSlugs.slice(start, start + testCase.pageSize)

      const request: Record<string, string | number> = {
        keyword: testCase.keyword,
        page: testCase.page,
        pageSize: testCase.pageSize,
      }
      if (testCase.category !== undefined) request.category = testCase.category
      if (testCase.priceMinCents !== undefined) request.priceMinCents = testCase.priceMinCents
      if (testCase.priceMaxCents !== undefined) request.priceMaxCents = testCase.priceMaxCents
      if (testCase.minSales !== undefined) request.minSales = testCase.minSales
      if (testCase.sort !== undefined) request.sort = testCase.sort

      const { status, body } = await list(request)
      assert.equal(status, 200, `${testCase.name}：HTTP 应返回 200`)
      assert.equal(body.page, testCase.page, `${testCase.name}：page 应回显请求页码`)
      assert.equal(body.pageSize, testCase.pageSize)
      assert.equal(body.total, total, `${testCase.name}：total 应等于 MySQL 期望的命中数`)
      assert.equal(body.totalPages, totalPages, `${testCase.name}：totalPages 应按每页数量计算`)
      assert.deepEqual(
        body.items.map((item) => item.slug),
        expectedPage,
        `${testCase.name}：slug 顺序应与 MySQL 期望一致`,
      )

      for (const item of body.items) {
        const expected = baseline.bySlug.get(item.slug)
        assert.ok(expected !== undefined, `${item.slug} 应存在于 MySQL 路径`)
        assert.deepEqual(
          businessFields(item),
          expected,
          `${testCase.name}：${item.slug} 的 11 个业务字段应与 MySQL 路径一致`,
        )
      }
    })
  }
})

test('V10 相关性排序：命中集合与顺序按预记录 fixture 验收（含 Apple A2096 与分词副作用）', async (t) => {
  for (const [keyword, expected] of Object.entries(RELEVANCE_FIXTURES)) {
    await t.test(`关键词「${keyword}」`, async () => {
      const { status, body } = await list({ keyword, pageSize: 50 })
      assert.equal(status, 200)
      assert.deepEqual(
        body.items.map((item) => item.slug),
        [...expected],
        `「${keyword}」的命中与顺序必须与预记录 fixture 一致`,
      )
      assert.equal(body.total, expected.length, `「${keyword}」total 应等于预记录命中数`)
      assert.equal(body.totalPages, 1, `「${keyword}」命中数不足一页`)
    })
  }

  // 工单点名要求：固定包含 Apple A2096。
  assert.ok(
    RELEVANCE_FIXTURES['Apple A2096']?.includes('airpods-max'),
    'Apple A2096 的预记录命中必须包含 airpods-max',
  )
})

test('隔离核对：测试只操作 products_es_test*，演示别名 products 前后不变', async () => {
  assert.equal(TEST_ALIAS, 'products_es_test_alias')
  assert.equal(productIndexVersion(TEST_INDEX), null, '测试索引名不能落在 products_vN 命名空间')

  const indexAdapter = new ElasticsearchProductIndexAdapter(client)
  assert.deepEqual(await indexAdapter.aliasIndices(TEST_ALIAS), [TEST_INDEX])
  assert.equal(await indexAdapter.count(TEST_INDEX), documents.length)
  assertDemoIndexStateUnchanged(demoBefore, await captureDemoIndexState(client))
})
