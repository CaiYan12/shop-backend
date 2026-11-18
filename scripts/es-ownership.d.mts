export interface ProcessRecord {
  pid: number
  parentPid?: number | null
  execPath?: string | null
  commandLine?: string | null
}

export type ProcessLookup = (pid: number) => ProcessRecord | null | undefined

export type ProcessRelation = 'self' | 'descendant' | null

export declare const DEFAULT_MAX_DEPTH: number

export declare function traceToLauncher(
  listenerPid: number,
  launcherPid: number,
  lookup: ProcessLookup,
  maxDepth?: number,
): ProcessRelation

export declare function isOwnedByLaunch(input: {
  listenerPid: number
  launcherPid: number
  esHome: string
  lookup: ProcessLookup
  maxDepth?: number
}): {
  owned: boolean
  relation: ProcessRelation
  reason: string
}
