import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { resolveHooksDir } from '../src/hooks-path.ts'

const ROOT = resolve('D:/repo/shop-backend')

test('普通检出的相对 hooks 路径解析到仓库根下', () => {
  const out = resolveHooksDir(ROOT, '.git/hooks')
  assert.equal(out, resolve(ROOT, '.git/hooks'))
  assert.ok(out.startsWith(ROOT), '相对路径应落在仓库根内')
})

test('worktree 返回的绝对路径不会被拼到仓库根后面', () => {
  const worktreeRoot = resolve('D:/repo/worktrees/shop-backend-impl')
  const absolute = resolve('D:/repo/shop-backend/.git/hooks')

  const out = resolveHooksDir(worktreeRoot, absolute)

  assert.equal(out, absolute, '绝对路径应原样返回')
  assert.ok(!out.includes('worktrees'), '不得把 worktree 根拼进绝对路径')
  assert.ok(!/[:][^\\/]+[:]/.test(out), '不得出现两个盘符')
})

test('命令输出带换行时先 trim 再解析', () => {
  const out = resolveHooksDir(ROOT, '.git/hooks\n')
  assert.equal(out, resolve(ROOT, '.git/hooks'))
})
