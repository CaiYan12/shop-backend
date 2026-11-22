/**
 * 本次启动器（elasticsearch.bat 的 cmd.exe）的终止守卫。
 *
 * 启动器已退出或 PID 被子进程复用时，只按 PID taskkill 会误杀无关进程。
 * 终止前必须用启动时记录的 PID / startTime / execPath 再核对一次。
 */

import { sameProcessIdentity } from './es-ownership.mjs'

/**
 * @param {{
 *   launcherPid: number,
 *   identity: { pid: number, startTime: string, execPath: string } | null,
 *   actual: { id?: number, pid?: number, startTime?: string | null, execPath?: string | null } | null,
 *   kill: (pid: number) => void,
 *   log?: (line: string) => void,
 * }} input
 * @returns {{ killed: boolean, reason: 'identity-unavailable' | 'identity-mismatch' | null }}
 */
export function terminateLauncher ({ launcherPid, identity, actual, kill, log = console.error }) {
  if (identity === null || identity === undefined) {
    log('[es] 无法读取启动器 ' + launcherPid + ' 的启动时间与可执行路径，不终止任何进程')
    return { killed: false, reason: 'identity-unavailable' }
  }
  if (!sameProcessIdentity(identity, actual)) {
    log('[es] 启动器归属校验失败：PID ' + launcherPid + ' 的启动时间或可执行路径与本次记录不符')
    log('[es]   记录 ' + JSON.stringify(identity) + '，实际 ' + JSON.stringify(actual))
    log('[es] 为避免 PID 复用误杀，本次不终止任何进程')
    return { killed: false, reason: 'identity-mismatch' }
  }
  kill(launcherPid)
  return { killed: true, reason: null }
}
