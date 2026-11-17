import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BACKEND_ROOT } from '../backend-root.ts'
import { runIfMain } from '../run-if-main.ts'
import { SEED_MANIFEST } from './seed-data.ts'
import { normalizeProductImagePath, productImageDirectory, type SeedManifest } from './seed-manifest.ts'

/** 待校验的种子清单与前端 public 目录（绝对路径）。 */
export interface VerifyImagesOptions {
  manifest: SeedManifest
  publicDir: string
}

/** 一张图片的校验问题；path 通常是清单里的原始写法，目录缺失时为该商品的图片目录。 */
export interface ImageProblem {
  slug: string
  path: string
  message: string
}

export interface ImageVerificationReport {
  /** 校验的图片引用总数 = carousel + detail。 */
  checked: number
  /** 轮播图引用数。 */
  carousel: number
  /** 详情块图片引用数。 */
  detail: number
  problems: ImageProblem[]
}

/**
 * 校验清单引用的图片：路径规范化后必须位于该商品目录内（D48），且文件真实存在。
 */
export function verifyProductImages ({ manifest, publicDir }: VerifyImagesOptions): ImageVerificationReport {
  let checked = 0
  let carousel = 0
  let detail = 0
  const problems: ImageProblem[] = []

  for (const product of manifest.products) {
    const directory = join(publicDir, 'images', 'products', product.slug)
    const directoryMissing = !(existsSync(directory) && statSync(directory).isDirectory())
    if (directoryMissing) {
      // 目录缺失时按商品报一次，避免把同一原因重复成「每张图片都不存在」。
      problems.push({
        slug: product.slug,
        path: productImageDirectory(product.slug),
        message: `商品图片目录不存在：${directory}`,
      })
    }

    /** 校验一处图片引用：归属（D48）与文件存在性；失败只记录，不中断其余引用。 */
    const checkReference = (rawPath: string): void => {
      checked += 1
      let normalized: string
      try {
        normalized = normalizeProductImagePath(rawPath, product.slug)
      } catch (error) {
        // 归属校验失败（含 ..、跨商品、非 n.webp）同样是一次失败。
        problems.push({
          slug: product.slug,
          path: rawPath,
          message: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (directoryMissing) {
        return
      }
      if (!existsSync(join(publicDir, normalized))) {
        problems.push({
          slug: product.slug,
          path: rawPath,
          message: `图片文件不存在：${normalized}`,
        })
      }
    }

    for (const image of product.images) {
      carousel += 1
      checkReference(image.path)
    }

    // 详情块里的图片引用同样要真实存在（D47）。
    for (const block of product.detail) {
      if (block.type === 'image') {
        detail += 1
        checkReference(block.path)
      }
    }
  }

  return { checked, carousel, detail, problems }
}

/** 指定前端 public 目录的环境变量；相对值从基准目录解析，绝对值原样使用。 */
export const FRONTEND_PUBLIC_DIR_ENV = 'FRONTEND_PUBLIC_DIR'
export const DEFAULT_FRONTEND_PUBLIC_DIR = '../shop-frontend/public'

export function resolveFrontendPublicDir (raw: string | undefined, baseDir: string): string {
  const value = raw?.trim()
  if (value === undefined || value === '') {
    return resolve(baseDir, DEFAULT_FRONTEND_PUBLIC_DIR)
  }
  return resolve(baseDir, value)
}

async function main (): Promise<void> {
  const publicDir = resolveFrontendPublicDir(process.env[FRONTEND_PUBLIC_DIR_ENV], BACKEND_ROOT)
  const report = verifyProductImages({ manifest: SEED_MANIFEST, publicDir })

  if (report.problems.length > 0) {
    console.error(`[verify-images] 失败：${report.problems.length} 个问题（公共目录 ${publicDir}）`)
    for (const problem of report.problems) {
      console.error(`  - ${problem.slug} ${problem.path}：${problem.message}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `[verify-images] 通过：${report.carousel} 张轮播 + ${report.detail} 处详情图引用（共 ${report.checked} 处）全部存在（公共目录 ${publicDir}）`,
  )
}

await runIfMain(import.meta.url, main)
