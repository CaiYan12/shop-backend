#!/usr/bin/env node
/**
 * 停止由 scripts/es-dev.mjs 启动的 Elasticsearch。
 *
 * 终止前校验三项：记录存在 + 进程存活 + 启动时间与可执行路径与记录一致。
 * 后两项是关键：进程号会被系统复用，只校验存活性可能误杀另一个 Java 进程。
 * 任一不符即拒绝终止，保留记录供人工核对。
 *
 * 不是本次入口创建的实例（例如人工在终端里启动的 ES）没有记录，本脚本不会碰它。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pidFile = join(root, '.run', 'es.json')

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pidOnPort (port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? ''
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    const local = cols[1] ?? ''
    if (!local.endsWith(':' + port)) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid)) return pid
  }
  return null
}

function processInfo (pid) {
  const script = [
    "$ErrorActionPreference='Stop';",
    '$p = Get-Process -Id ' + pid + ';',
    "[pscustomobject]@{ id = $p.Id; startTime = $p.StartTime.ToUniversalTime().ToString('o'); execPath = $p.Path } | ConvertTo-Json -Compress",
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

/** Windows 路径比较统一大小写与分隔符，避免同一个路径因写法不同被误判为不符。 */
function samePath (left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left.replace(/\//g, '\\').toLowerCase() === right.replace(/\//g, '\\').toLowerCase()
}

if (!existsSync(pidFile)) {
  console.log('[es] 未发现运行记录，Elasticsearch 可能未启动或不是本次入口创建的')
  process.exit(0)
}

let record
try {
  record = JSON.parse(readFileSync(pidFile, 'utf8'))
} catch {
  console.error('[es] 运行记录损坏，请手工检查 .run/es.json')
  process.exit(1)
}

if (!isAlive(record.pid)) {
  console.log('[es] 进程 ' + record.pid + ' 已不存在，清理记录')
  unlinkSync(pidFile)
  process.exit(0)
}

const actual = processInfo(record.pid)
if (actual === null) {
  console.error('[es] 无法读取进程 ' + record.pid + ' 的启动时间与可执行路径')
  console.error('[es] 归属无法证明，本次不终止任何进程；可人工核对 .run/es.json 后处理')
  process.exit(1)
}

if (actual.startTime !== record.startTime) {
  console.error('[es] 归属校验失败：进程 ' + record.pid + ' 的启动时间与记录不符')
  console.error('[es]   记录 ' + String(record.startTime) + '，实际 ' + String(actual.startTime))
  console.error('[es] 为避免误杀，本次不终止任何进程')
  process.exit(1)
}

if (!samePath(actual.execPath, record.execPath)) {
  console.error('[es] 归属校验失败：进程 ' + record.pid + ' 的可执行路径与记录不符')
  console.error('[es]   记录 ' + String(record.execPath) + '，实际 ' + String(actual.execPath))
  console.error('[es] 为避免误杀，本次不终止任何进程')
  process.exit(1)
}

spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'inherit' })
unlinkSync(pidFile)

const deadline = Date.now() + 10000
while (Date.now() < deadline && pidOnPort(record.httpPort) !== null) sleep(200)

if (pidOnPort(record.httpPort) === null) {
  console.log('[es] Elasticsearch 已停止，端口 ' + record.httpPort + ' 已释放')
  process.exit(0)
}

console.error('[es] 已发出终止指令，但端口 ' + record.httpPort + ' 仍在监听')
process.exit(1)
