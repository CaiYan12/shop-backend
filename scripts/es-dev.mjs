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
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOwnedByLaunch, sameProcessIdentity } from './es-ownership.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runDir = join(root, '.run')
const pidFile = join(runDir, 'es.json')

/**
 * 本轮运行归属证据（可选，路径来自 ES_PROVENANCE_FILE）。
 *
 * gate 不能只看 es-dev 的退出码：复用已有实例同样 exit 0，无法区分「本次新建」。
 * 该文件用 created 区分两者，由调用方决定是否登记 / 收尾停机；未设置时完全不写，
 * 既有行为（.run/es.json、es-stop、ownership 判定）不变。
 */
const provenanceEnv = process.env.ES_PROVENANCE_FILE ?? ''
const provenanceFile = provenanceEnv.trim() === '' ? null : resolvePath(provenanceEnv)

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

/**
 * 收尾本次 Start-Process 返回的启动器。
 *
 * 启动器（cmd.exe）是本次拉起的，属本轮清理范围：服务 JVM 由它派生，只按监听端口
 * 终止会漏掉「监听者尚未出现」「监听者无法确认」「端口被外部进程占用」三种情况，
 * 留下 cmd / powershell 中间进程（#32 复审实测：listenerPid 为 null 时残留
 * cmd 42916 + powershell 52536）。外部监听进程不属于本轮，绝不在此连带终止。
 */
function killLauncher (launcherPid) {
  if (launcherIdentity === null) {
    console.error('[es] 无法读取启动器 ' + launcherPid + ' 的启动时间与可执行路径，不终止任何进程')
    return false
  }
  const actual = processInfo(launcherPid)
  if (!sameProcessIdentity(launcherIdentity, actual)) {
    console.error('[es] 启动器归属校验失败：PID ' + launcherPid + ' 的启动时间或可执行路径与本次记录不符')
    console.error('[es]   记录 ' + JSON.stringify(launcherIdentity) + '，实际 ' + JSON.stringify(actual))
    console.error('[es] 为避免 PID 复用误杀，本次不终止任何进程')
    return false
  }
  killTree(launcherPid, '本次启动的启动器进程树')
  return true
}

const PROVENANCE_SCHEMA = 'es-provenance/v1'

/**
 * 写运行归属证据。写失败只告警：该文件服务于调用方的归属判定，
 * 不该把一个已经成功的启动变成失败，也不参与 .run/es.json 的语义。
 */
function writeProvenance (record) {
  if (provenanceFile === null) return
  try {
    mkdirSync(dirname(provenanceFile), { recursive: true })
    const payload = { schema: PROVENANCE_SCHEMA, ...record, at: new Date().toISOString() }
    writeFileSync(provenanceFile, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[es] 写归属证据失败（不影响本次结果）：' + provenanceFile + '：' + message)
  }
}

/** 复用路径的证据：pid / startTime 取监听端口上的进程，取不到写 null。 */
function recordReuse ({ version, listenerPid }) {
  const listener = listenerPid === undefined ? pidOnPort(CONFIG.httpPort) : listenerPid
  const proc = listener === null ? null : processInfo(listener)
  writeProvenance({
    created: false,
    reused: true,
    pid: listener,
    startTime: proc?.startTime ?? null,
    httpPort: CONFIG.httpPort,
    version: version ?? null,
  })
}

/** 失败退出：先落 created:false / failed:true 的证据，再以非零码退出。 */
function failExit (reason, pid = null) {
  writeProvenance({
    created: false,
    failed: true,
    reason,
    pid: Number.isInteger(pid) ? pid : null,
  })
  process.exit(1)
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
  recordReuse({ version: info.version.number, listenerPid: owner })
  process.exit(0)
}

// ② 端口被占用但不是可用实例：不启动第二个进程，交给人工处理。
if (info !== null) {
  const unreachableReason = baseUrl + ' 有响应但集群状态不可用（' + String(health) + '），不启动第二个进程'
  console.error('[es] ' + unreachableReason)
  failExit(unreachableReason)
}
const occupied = pidOnPort(CONFIG.httpPort)
if (occupied !== null) {
  const occupiedReason = '端口 ' + CONFIG.httpPort + ' 已被进程 ' + occupied + ' 占用，且不是可用的 Elasticsearch'
  console.error('[es] ' + occupiedReason)
  console.error('[es] 请先释放该端口，或设置 ES_HTTP_PORT 指向其他端口')
  failExit(occupiedReason, occupied)
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
      recordReuse({ version: readyInfo?.version?.number })
      process.exit(0)
    }
  }
  const waitTimeoutReason = '等待记录中的进程就绪超时（' + Math.round(CONFIG.readyTimeoutMs / 1000) + 's）'
  reportTimeout(waitTimeoutReason)
  failExit(waitTimeoutReason, pidOnPort(CONFIG.httpPort))
}

// ④ 需要启动：先确认安装目录，再清理失效记录。
const launcher = join(CONFIG.home, 'bin', 'elasticsearch.bat')
if (!existsSync(launcher)) {
  console.error('[es] 未找到启动器：' + launcher)
  console.error('[es] 安装目录默认 D:\\Dev\\elasticsearch-9.5.6，可用 ES_HOME 覆盖')
  failExit('未找到启动器：' + launcher)
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
  const launchFailure = '启动失败：' + ((launch.stderr ?? '').trim() || 'Start-Process 返回非零')
  console.error('[es] ' + launchFailure)
  failExit(launchFailure)
}
const launcherPid = Number((launch.stdout ?? '').trim())
if (!Number.isInteger(launcherPid) || launcherPid <= 0) {
  const pidFailure = '启动失败：无法取得本次启动器的 PID（输出 ' + JSON.stringify((launch.stdout ?? '').trim()) + '）'
  console.error('[es] ' + pidFailure)
  failExit(pidFailure)
}
const launcherProcess = processInfo(launcherPid)
const launcherIdentity = launcherProcess === null
  ? null
  : { pid: launcherPid, startTime: launcherProcess.startTime, execPath: launcherProcess.execPath }
console.log('[es] 启动器 PID ' + launcherPid + '；归属 ' + (launcherIdentity === null ? '无法证明' : '已记录'))

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
  const readyTimeoutReason = '等待 Elasticsearch 就绪超时（' + Math.round(CONFIG.readyTimeoutMs / 1000) + 's）'
  reportTimeout(readyTimeoutReason)
  if (listenerPid === null) {
    console.error('[es] 没有发现监听 ' + CONFIG.httpPort + ' 的进程，只收尾本次启动器')
  } else {
    const ownership = ownershipOf(listenerPid, launcherPid)
    if (ownership.owned) {
      // 监听者已出现且归属成立：先杀监听进程，再连带收尾启动器。
      killTree(listenerPid, '本次启动的监听进程')
    } else {
      console.error('[es] 端口 ' + CONFIG.httpPort + ' 被外部进程 ' + listenerPid + ' 占用，本次不终止')
      console.error('[es] ' + ownership.reason)
    }
  }
  // 无论监听者是否出现，本次拉起的启动器进程树都要收尾：否则半启动的 cmd /
  // powershell 会一直留在系统里（#32 复审实测复现）。外部监听者不属本轮，不连带终止。
  killLauncher(launcherPid)
  failExit(readyTimeoutReason, listenerPid)
}

const elapsedMs = Date.now() - startedAt
if (listenerPid === null) listenerPid = pidOnPort(CONFIG.httpPort)
if (listenerPid === null) {
  console.error('[es] 已就绪但无法确定监听 ' + CONFIG.httpPort + ' 的进程，归属无法证明')
  console.error('[es] 本次不写运行记录，也不宣称启动成功')
  // 监听者无法确认，但启动器仍是本轮拉起的，必须收尾，避免留下未登记的进程树。
  killLauncher(launcherPid)
  failExit('已就绪但无法确定监听 ' + CONFIG.httpPort + ' 的进程，归属无法证明')
}
const ownership = ownershipOf(listenerPid, launcherPid)
if (!ownership.owned) {
  console.error('[es] 端口 ' + CONFIG.httpPort + ' 被外部进程 ' + listenerPid + ' 占用，本次不写运行记录')
  console.error('[es] ' + ownership.reason)
  // 只收尾本次启动器：外部监听者不属本轮，绝不连带终止。
  killLauncher(launcherPid)
  failExit('端口 ' + CONFIG.httpPort + ' 被外部进程 ' + listenerPid + ' 占用，本次不写运行记录', listenerPid)
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

writeProvenance({
  created: true,
  pid: listenerPid,
  startTime: proc?.startTime ?? null,
  httpPort: CONFIG.httpPort,
  version: readyInfo?.version?.number ?? null,
  startupMs: elapsedMs,
})

console.log('[es] Elasticsearch 已就绪：pid=' + listenerPid + ' 版本 ' + (readyInfo?.version?.number ?? '未知') + ' 端口 ' + CONFIG.httpPort + ' 耗时 ' + (elapsedMs / 1000).toFixed(1) + 's')
