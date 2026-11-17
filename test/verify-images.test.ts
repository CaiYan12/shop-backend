import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKEND_ROOT } from '../src/backend-root.ts'
import { resolveFrontendPublicDir, verifyProductImages } from '../src/db/verify-images.ts'
import { SEED_MANIFEST } from '../src/db/seed-data.ts'
import type { SeedManifest, SeedProduct } from '../src/db/seed-manifest.ts'

const tempRoots: string[] = []

after(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
})

/** 在前端 public 目录的临时副本里造出 images/products/{slug}/ 与给定文件。 */
async function makePublicDir (tree: Record<string, string[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'shop-verify-images-'))
  tempRoots.push(root)
  for (const [slug, files] of Object.entries(tree)) {
    const directory = join(root, 'images', 'products', slug)
    await mkdir(directory, { recursive: true })
    for (const file of files) {
      await writeFile(join(directory, file), Buffer.from('webp-fixture'))
    }
  }
  return root
}

function productFixture (slug: string, imagePaths: string[]): SeedProduct {
  return {
    slug,
    name: `${slug} 测试商品`,
    categorySlug: 'audio',
    brand: '测试品牌',
    model: 'TEST-1',
    rating: 4.5,
    sales: 10,
    detail: [{ type: 'text', text: '测试详情' }],
    dimensions: [
      { name: '颜色', options: ['黑', '白'] },
      { name: '版本', options: ['标准版', '进阶版'] },
    ],
    variants: [
      { sku: `${slug}-1`, option1Value: '黑', option2Value: '标准版', price: 100, originalPrice: 120, stock: 5 },
    ],
    images: imagePaths.map((path, index) => ({ path, alt: `图片 ${index + 1}` })),
  }
}

function manifestWith (products: SeedProduct[]): SeedManifest {
  return { categories: [{ slug: 'audio', name: '音频设备' }], products }
}

test('图片全部存在时校验通过', async () => {
  const publicDir = await makePublicDir({ 'aurora-headphones': ['1.webp', '2.webp'] })
  const manifest = manifestWith([
    productFixture('aurora-headphones', [
      '/images/products/aurora-headphones/1.webp',
      '/images/products/aurora-headphones/2.webp',
    ]),
  ])

  const report = verifyProductImages({ manifest, publicDir })

  assert.deepEqual(report.problems, [])
  assert.equal(report.checked, 2)
  assert.equal(report.carousel, 2, '两张轮播图都应计入 carousel')
  assert.equal(report.detail, 0, '没有详情图时 detail 为 0')
})

test('图片文件缺失时逐个报告问题，不静默跳过', async () => {
  const publicDir = await makePublicDir({ 'aurora-headphones': ['1.webp'] })
  const manifest = manifestWith([
    productFixture('aurora-headphones', [
      '/images/products/aurora-headphones/1.webp',
      '/images/products/aurora-headphones/2.webp',
      '/images/products/aurora-headphones/3.webp',
    ]),
  ])

  const report = verifyProductImages({ manifest, publicDir })

  assert.equal(report.checked, 3)
  assert.equal(report.problems.length, 2)
  assert.deepEqual(
    report.problems.map((problem) => problem.path),
    ['/images/products/aurora-headphones/2.webp', '/images/products/aurora-headphones/3.webp'],
  )
  assert.equal(report.problems[0]!.slug, 'aurora-headphones')
  assert.match(report.problems[0]!.message, /不存在/)
})

test('含 .. 或指向别的商品目录的路径被拒', async () => {
  const publicDir = await makePublicDir({
    'aurora-headphones': ['1.webp'],
    'pulse-earbuds': ['1.webp'],
  })
  const manifest = manifestWith([
    productFixture('aurora-headphones', [
      '/images/products/aurora-headphones/1.webp',
      '/images/products/pulse-earbuds/1.webp',
      '/images/products/aurora-headphones/../pulse-earbuds/1.webp',
    ]),
  ])

  const report = verifyProductImages({ manifest, publicDir })

  assert.equal(report.checked, 3)
  assert.equal(report.problems.length, 2)
  assert.equal(report.problems[0]!.path, '/images/products/pulse-earbuds/1.webp')
  assert.match(report.problems[0]!.message, /不在商品 aurora-headphones 的目录内/)
  assert.equal(report.problems[1]!.path, '/images/products/aurora-headphones/../pulse-earbuds/1.webp')
  assert.match(report.problems[1]!.message, /不得包含 \.\./)
})

test('商品图片目录不存在时报告问题', async () => {
  const publicDir = await makePublicDir({ 'pulse-earbuds': ['1.webp'] })
  const manifest = manifestWith([
    productFixture('aurora-headphones', [
      '/images/products/aurora-headphones/1.webp',
      '/images/products/aurora-headphones/2.webp',
    ]),
  ])

  const report = verifyProductImages({ manifest, publicDir })

  assert.equal(report.checked, 2)
  assert.equal(report.problems.length, 1)
  assert.equal(report.problems[0]!.path, '/images/products/aurora-headphones/')
  assert.match(report.problems[0]!.message, /目录不存在/)
})

test('详情块引用的图片同样校验', async () => {
  const publicDir = await makePublicDir({ 'aurora-headphones': ['1.webp'] })
  const product = productFixture('aurora-headphones', ['/images/products/aurora-headphones/1.webp'])
  const manifest = manifestWith([
    {
      ...product,
      detail: [
        { type: 'text', text: '测试详情' },
        { type: 'image', path: '/images/products/aurora-headphones/9.webp', alt: '详情图' },
      ],
    },
  ])

  const report = verifyProductImages({ manifest, publicDir })

  assert.equal(report.checked, 2)
  assert.equal(report.carousel, 1, '轮播图与详情图分别计数')
  assert.equal(report.detail, 1, '详情图引用计入 detail')
  assert.equal(report.problems.length, 1)
  assert.equal(report.problems[0]!.path, '/images/products/aurora-headphones/9.webp')
  assert.match(report.problems[0]!.message, /不存在/)
})

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = join(repoRoot, 'src', 'db', 'verify-images.ts')

interface CliResult {
  code: number | null
  output: string
}

/** 以子进程方式跑脚本，模拟真实调用（cwd、环境变量、脚本路径都可控）。 */
function runCli (options: { cwd: string; publicDir?: string, script?: string }): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env }
    delete env.FRONTEND_PUBLIC_DIR
    if (options.publicDir !== undefined) {
      env.FRONTEND_PUBLIC_DIR = options.publicDir
    }
    const child = spawn(process.execPath, [options.script ?? scriptPath], { cwd: options.cwd, env })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => { resolvePromise({ code, output }) })
  })
}

/** 按真实种子清单在临时目录里造出全部被引用的文件。 */
async function makePublicDirFromManifest (manifest: SeedManifest): Promise<string> {
  const tree: Record<string, string[]> = {}
  const add = (slug: string, path: string): void => {
    const files = tree[slug] ?? (tree[slug] = [])
    files.push(path.slice(path.lastIndexOf('/') + 1))
  }
  for (const product of manifest.products) {
    for (const image of product.images) add(product.slug, image.path)
    for (const block of product.detail) {
      if (block.type === 'image') add(product.slug, block.path)
    }
  }
  return makePublicDir(tree)
}

test('缺文件时脚本以非零码退出并指出缺哪张', async () => {
  const publicDir = await makePublicDirFromManifest(SEED_MANIFEST)
  const product = SEED_MANIFEST.products.find((candidate) => candidate.images.length >= 3)
  assert.ok(product !== undefined, '种子清单应有至少 3 张图片的商品')
  const missing = product.images[2]!
  await rm(join(publicDir, missing.path))

  const result = await runCli({ cwd: repoRoot, publicDir })

  assert.equal(result.code, 1)
  assert.match(result.output, /图片文件不存在/)
  assert.ok(result.output.includes(missing.path), `输出应指出缺哪张：${missing.path}`)
})

test('相对路径从后端仓库根目录解析，与执行位置无关', async () => {
  const relativeDir = join('test', `.missing-public-${process.pid}`)
  const expected = join(repoRoot, relativeDir)

  // 路径解析只做函数级断言：相对值一律基于 BACKEND_ROOT。
  assert.equal(resolveFrontendPublicDir(relativeDir, BACKEND_ROOT), expected)

  // CLI 侧只断言退出码：该目录本就不存在，脚本必须以非零码退出。
  const results = [
    await runCli({ cwd: repoRoot, publicDir: relativeDir, script: join('src', 'db', 'verify-images.ts') }),
    await runCli({ cwd: join(repoRoot, 'test'), publicDir: relativeDir }),
    await runCli({ cwd: tmpdir(), publicDir: relativeDir }),
  ]

  for (const result of results) {
    assert.equal(result.code, 1, '目录缺失时脚本应以 1 退出')
  }
})

test('未设置 FRONTEND_PUBLIC_DIR 时默认指向同级前端仓库的 public', async () => {
  const expected = resolve(repoRoot, '..', 'shop-frontend', 'public')

  // 默认目录是否存在取决于仓库布局（主检出里有、worktree 里没有），
  // 因此路径解析只做函数级断言，CLI 侧只断言退出码与该布局一致。
  assert.equal(resolveFrontendPublicDir(undefined, BACKEND_ROOT), expected)
  assert.equal(resolveFrontendPublicDir('', BACKEND_ROOT), expected, '空字符串回退到默认目录')
  assert.equal(resolveFrontendPublicDir('   ', BACKEND_ROOT), expected, '空白回退到默认目录')

  const result = await runCli({ cwd: tmpdir() })
  assert.equal(result.code, existsSync(expected) ? 0 : 1, '退出码应与默认目录是否存在一致')
})

test('素材齐全时脚本以 0 退出', async () => {
  const publicDir = await makePublicDirFromManifest(SEED_MANIFEST)

  const result = await runCli({ cwd: tmpdir(), publicDir })

  assert.equal(result.code, 0)
})
