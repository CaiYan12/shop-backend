#!/usr/bin/env node
/** 把 scripts/hooks/pre-commit 装进当前检出的 git hooks 目录。pnpm install 时由 prepare 自动执行。 */
import { copyFileSync, chmodSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'scripts', 'hooks', 'pre-commit')

if (!existsSync(SRC)) { console.log('[hooks] 未找到 hook 源文件，跳过'); process.exit(0) }
let hooksDir
try {
  hooksDir = execSync('git rev-parse --git-path hooks', { cwd: ROOT, encoding: 'utf8' }).trim()
} catch { console.log('[hooks] 非 git 检出，跳过'); process.exit(0) }
// worktree 下 `--git-path hooks` 返回公共 git 目录的绝对路径，必须用 resolve 而不是 join，
// 否则会拼成 `<worktree>\D:\...\.git\hooks` 这种非法路径。
const dest = resolve(ROOT, hooksDir, 'pre-commit')
copyFileSync(SRC, dest)
try { chmodSync(dest, 0o755) } catch {}
console.log('[hooks] 已安装 pre-commit')
