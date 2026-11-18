#!/usr/bin/env node
/**
 * 启动 Elasticsearch 并记录进程归属，供 es-stop.mjs 校验（C47）。
 *
 * 流程：先探测 http://127.0.0.1:9201/ 是否已有可用实例；可用则复用、不启动第二个进程。
 * 需要启动时记录启动器 PID、等待就绪；只有确认监听者属于本次启动才终止或写记录。
 * 超时输出日志目录中最新的日志末尾若干行。
 *
 * 与 dev.mjs 同构，但记录写在单独的 .run/es.json：两个进程生命周期互相独立，
 * 后端停掉后 ES 可能仍在运行，反之亦然，混在一份记录里会互相覆盖。
 *
 * 本脚本失败不阻断后端：start.bat 不用 && 串联，es-dev.mjs 非零退出后照常启动应用。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOwnedByLaunch } from './es-ownership.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runDir = join(root, '.run')
const pidFile = join(runDir, 'es.json')

const CONFIG = {
  name: 'elasticsearch',
  home: process.env.ES_HOME ?? 'D:\\Dev\\elasticsearch-9.5.6',
  dataDir: process.env.ES_DATA_DIR ?? 'D:\\Dev\\elasticsearch-data',
  logDir: process.env.ES_LOG_DIR ?? 'D:\\Dev\\elasticsearch-logs',
  host: '127.0.0.1',
  httpPort: Number(process.env.ES_HTTP_PORT ?? 9201),
  readyTimeoutMs: Number(process.env.ES_READY_TIMEOUT_MS ?? 180000),
  pollMs: 1000,
  logTailLines: 20,
}

const baseUrl = 'http://' + CONFIG.host + ':' + CONFIG.httpPort + '/'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readPidFile () {
  if (!existsSync(pidFile)) return null
  try {
    return JSON.parse(readFileSync(pidFile, 'utf8'))
  } catch {
    return null
  }
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 监听指定端口的进程号；与 dev.mjs 同一实现，端口归属是复用与停止的判据。 */
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

/**
 * 读取进程启动时间与可执行路径。这两个值是不接管、不误杀其他 Java 进程的依据：
 * 进程号会被系统复用，仅凭进程号无法证明「它就是本次入口创建的那个进程」。
 */
function processInfo (pid) {
  const script = [
    "$ErrorActionPreference='Stop';",
    '$p = Get-Process -Id ' + pid + ';',
    "[pscustomobject]@{ id = $p.Id; startTime = $p.StartTime.ToUniversalTime().ToString('o'); execPath = $p.Path } | ConvertTo-Json -Compress",
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return null
  try {
    const info = JSON.parse(result.stdout)
    return { id: info.id, startTime: info.startTime ?? null, execPath: info.execPath ?? null }
  } catch {
    return null
  }
}

/**
 * 读取 PID、父 PID、可执行路径与命令行。归属判定需要 ParentProcessId，
 * Get-Process 不提供，因此单独走 Get-CimInstance。
 */
function processRecord (pid) {
  const script = [
    "$ErrorActionPreference='Stop';",
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '";',
    'if ($null -eq $p) { exit 3 };',
    '[pscustomobject]@{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; execPath = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return null
  try {
    const info = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
    return {
      pid: Number(info.pid),
      parentPid: Number.isInteger(info.parentPid) ? info.parentPid : null,
      execPath: typeof info.execPath === 'string' ? info.execPath : null,
      commandLine: typeof info.commandLine === 'string' ? info.commandLine : null,
    }
  } catch {
    return null
  }
}

/** 监听者是否属于本次启动：启动器本身或其后代，且路径/命令行能佐证来自 ES 安装目录。 */
function ownershipOf (listenerPid, launcherPid) {
  return isOwnedByLaunch({
    listenerPid,
    launcherPid,
    esHome: CONFIG.home,
    lookup: processRecord,
  })
}

/** 只读文件末尾若干字节，避免为了看几行日志把整份日志读进内存。 */
function tailFile (path, bytes = 65536) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const length = size - start
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function latestLogTail () {
  if (!existsSync(CONFIG.logDir)) return null
  const files = readdirSync(CONFIG.logDir)
    .filter(name => name.endsWith('.log'))
    .map(name => ({ name, path: join(CONFIG.logDir, name), mtime: statSync(join(CONFIG.logDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (files.length === 0) return null
  try {
    const lines = tailFile(files[0].path).split(/\r?\n/).filter(line => line.trim() !== '')
    return { path: files[0].path, lines: lines.slice(-CONFIG.logTailLines) }
  } catch {
    return null
  }
}

async function clusterHealth () {
  try {
    const response = await fetch(baseUrl + '_cluster/health?wait_for_status=yellow&timeout=2s', {
      signal: AbortSignal.timeout(5000),
    })
    const body = await response.json()
    return typeof body?.status === 'string' ? body.status : null
  } catch {
    return null
  }
}

async function clusterInfo () {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const body = await response.json()
    return typeof body?.version?.number === 'string' ? body : null
  } catch {
    return null
  }
}

function reportTimeout (why) {
  console.error('[es] ' + why)
  const tail = latestLogTail()
  if (tail === null) {
    console.error('[es] 日志目录无可读日志：' + CONFIG.logDir)
  } else {
    console.error('[es] 日志末尾（' + tail.path + '）：')
    for (const line of tail.lines) console.error('  ' + line)
  }
}

function killTree (pid, label) {
  if (!Number.isInteger(pid)) return
  console.error('[es] 终止未就绪的进程 ' + pid + '（' + label + '）')
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

mkdirSync(runDir, { recursive: true })
const existing = readPidFile()

// ① 已有可用实例：复用，不创建第二个进程。
const info = await clusterInfo()
const health = info === null ? null : await clusterHealth()
if (info !== null && (health === 'yellow' || health === 'green')) {
  const owner = pidOnPort(CONFIG.httpPort)
  console.log('[es] 复用已有实例：' + baseUrl + ' 版本 ' + info.version.number + ' 状态 ' + health + (owner === null ? '' : ' pid=' + owner))
  if (existing !== null && !(isAlive(existing.pid) && owner === existing.pid)) {
    unlinkSync(pidFile)
    console.log('[es] 运行记录与当前实例不符，已清除（不接管非本次入口创建的进程）')
  }
  process.exit(0)
}

// ② 端口被占用但不是可用实例：不启动第二个进程，交给人工处理。
if (info !== null) {
  console.error('[es] ' + baseUrl + ' 有响应但集群状态不可用（' + String(health) + '），不启动第二个进程')
  process.exit(1)
}
const occupied = pidOnPort(CONFIG.httpPort)
if (occupied !== null) {
  console.error('[es] 端口 ' + CONFIG.httpPort + ' 已被进程 ' + occupied + ' 占用，且不是可用的 Elasticsearch')
  console.error('[es] 请先释放该端口，或设置 ES_HTTP_PORT 指向其他端口')
  process.exit(1)
}

// ③ 记录中的进程仍在但尚未就绪：转入等待，避免重复拉起。
if (existing !== null && isAlive(existing.pid)) {
  console.log('[es] 记录中的进程 ' + existing.pid + ' 仍在运行但未就绪，等待它就绪')
  const deadline = Date.now() + CONFIG.readyTimeoutMs
  while (Date.now() < deadline) {
    await sleep(CONFIG.pollMs)
    const status = await clusterHealth()
    if (status === 'yellow' || status === 'green') {
      const readyInfo = await clusterInfo()
      console.log('[es] 进程 ' + existing.pid + ' 已就绪（版本 ' + (readyInfo?.version?.number ?? '未知') + '）')
      process.exit(0)
    }
  }
  reportTimeout('等待记录中的进程就绪超时（' + Math.round(CONFIG.readyTimeoutMs / 1000) + 's）')
  process.exit(1)
}

// ④ 需要启动：先确认安装目录，再清理失效记录。
const launcher = join(CONFIG.home, 'bin', 'elasticsearch.bat')
if (!existsSync(launcher)) {
  console.error('[es] 未找到启动器：' + launcher)
  console.error('[es] 安装目录默认 D:\\Dev\\elasticsearch-9.5.6，可用 ES_HOME 覆盖')
  process.exit(1)
}
if (existing !== null) {
  console.log('[es] 发现失效的运行记录，已清理')
  unlinkSync(pidFile)
}
mkdirSync(CONFIG.dataDir, { recursive: true })
mkdirSync(CONFIG.logDir, { recursive: true })

const startedAt = Date.now()
console.log('[es] 启动 ' + launcher)
// 用 PowerShell 的 Start-Process -WindowStyle Hidden 拉起（#26）：
// - .bat 不能直接 spawn，交给 cmd 时 Node 的 detached 会给子进程一个新控制台窗口，桌面上可见；
// - 那个控制台窗口一旦关闭，ES 也随之退出（启动入口的控制台不再存活时尤其明显）。
// Start-Process 不产生可见窗口，也不把 ES 绑在启动入口的控制台上。
const launch = spawnSync('powershell', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "Start-Process -FilePath '" + launcher.replace(/'/g, "''") + "'" +
    " -WorkingDirectory '" + CONFIG.home.replace(/'/g, "''") + "'" +
    ' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id',
], { encoding: 'utf8' })
if (launch.status !== 0) {
  console.error('[es] 启动失败：' + ((launch.stderr ?? '').trim() || 'Start-Process 返回非零'))
  process.exit(1)
}
const launcherPid = Number((launch.stdout ?? '').trim())
if (!Number.isInteger(launcherPid) || launcherPid <= 0) {
  console.error('[es] 启动失败：无法取得本次启动器的 PID（输出 ' + JSON.stringify((launch.stdout ?? '').trim()) + '）')
  process.exit(1)
}
console.log('[es] 启动器 PID ' + launcherPid)

let listenerPid = null
let ready = false
const deadline = Date.now() + CONFIG.readyTimeoutMs
while (Date.now() < deadline) {
  await sleep(CONFIG.pollMs)
  if (listenerPid === null) listenerPid = pidOnPort(CONFIG.httpPort)
  const status = await clusterHealth()
  if (status === 'yellow' || status === 'green') {
    ready = true
    break
  }
}

if (!ready) {
  reportTimeout('等待 Elasticsearch 就绪超时（' + Math.round(CONFIG.readyTimeoutMs / 1000) + 's）')
  if (listenerPid === null) {
    console.error('[es] 没有发现监听 ' + CONFIG.httpPort + ' 的进程，本次没有可终止的进程')
  } else {
    const ownership = ownershipOf(listenerPid, launcherPid)
    if (ownership.owned) {
      killTree(listenerPid, '本次启动的监听进程')
    } else {
      console.error('[es] 端口 ' + CONFIG.httpPort + ' 被外部进程 ' + listenerPid + ' 占用，本次不终止')
      console.error('[es] ' + ownership.reason)
    }
  }
  process.exit(1)
}

const elapsedMs = Date.now() - startedAt
if (listenerPid === null) listenerPid = pidOnPort(CONFIG.httpPort)
if (listenerPid === null) {
  console.error('[es] 已就绪但无法确定监听 ' + CONFIG.httpPort + ' 的进程，归属无法证明')
  console.error('[es] 本次不写运行记录，也不宣称启动成功')
  process.exit(1)
}
const ownership = ownershipOf(listenerPid, launcherPid)
if (!ownership.owned) {
  console.error('[es] 端口 ' + CONFIG.httpPort + ' 被外部进程 ' + listenerPid + ' 占用，本次不写运行记录')
  console.error('[es] ' + ownership.reason)
  process.exit(1)
}

const readyInfo = await clusterInfo()
const proc = processInfo(listenerPid)
if (proc === null || proc.startTime === null || proc.execPath === null) {
  console.error('[es] 无法读取进程 ' + listenerPid + ' 的启动时间与可执行路径；停止时需要人工核对 .run/es.json')
}

writeFileSync(pidFile, JSON.stringify({
  name: CONFIG.name,
  pid: listenerPid,
  startTime: proc?.startTime ?? null,
  execPath: proc?.execPath ?? null,
  httpPort: CONFIG.httpPort,
  esHome: CONFIG.home,
  startedAt: new Date(startedAt).toISOString(),
  startupMs: elapsedMs,
}, null, 2) + '\n', 'utf8')

console.log('[es] Elasticsearch 已就绪：pid=' + listenerPid + ' 版本 ' + (readyInfo?.version?.number ?? '未知') + ' 端口 ' + CONFIG.httpPort + ' 耗时 ' + (elapsedMs / 1000).toFixed(1) + 's')
