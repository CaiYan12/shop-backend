import { resolve } from 'node:path'

/**
 * 把 `git rev-parse --git-path hooks` 的输出解析成绝对路径。
 *
 * 普通检出返回相对路径（`.git/hooks`），worktree 返回公共 git 目录的**绝对路径**
 * （如 `D:/repo/shop-backend/.git/hooks`）。两者都必须走 `resolve`：
 * `join` 会把绝对路径拼到仓库根后面，得到 `<worktree>\D:\...\.git\hooks` 这种非法路径。
 */
export function resolveHooksDir (root: string, gitPathOutput: string): string {
  return resolve(root, gitPathOutput.trim())
}
