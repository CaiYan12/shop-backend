import {
  SearchUnavailableError,
  type ProductSearchAdapter,
  type ProductSearchQuery,
  type ProductSearchResult,
  type ProductSuggestionQuery,
  type ProductSuggestionResult,
} from './product-search.ts'

/** 失败冷却窗口长度（#24）：5 秒，关键词搜索与商品联想共用。 */
export const SEARCH_COOLDOWN_MS = 5_000

export interface SearchCooldownOptions {
  /** 冷却窗口长度（毫秒）；默认 5 s。 */
  cooldownMs?: number
  /** 时钟（毫秒）；默认 `Date.now`。测试注入假时钟，避免真等 5 秒。 */
  now?: () => number
}

/**
 * 搜索降级冷却（#24）。
 *
 * 冷却状态**归包装实例所有**：应用工厂每次 `createApp` 调用新建一个包装，
 * 因此状态按应用实例管理，不跨实例共享。
 *
 * 语义：
 * - 可用性故障（适配器抛 `SearchUnavailableError`）后开窗 5 秒；
 * - 窗口内的请求直接抛不可用，不再触达适配器，也不等连接超时；关键词搜索与商品联想共用这个窗口；
 * - 窗口到期只放行**一次**恢复探测：探测成功即恢复服务，失败续开 5 秒；
 *   探测进行中到达的并发请求继续直接抛不可用（单飞，避免雪崩）；
 * - 非可用性异常（程序错误）不开窗、也不续窗，路由仍按 500 处理。
 *
 * 端口本身不保持状态；路由把 `SearchUnavailableError` 映射为 `503 SEARCH_NOT_AVAILABLE`。
 */
export function withSearchCooldown (
  adapter: ProductSearchAdapter,
  options: SearchCooldownOptions = {},
): ProductSearchAdapter {
  const cooldownMs = options.cooldownMs ?? SEARCH_COOLDOWN_MS
  const now = options.now ?? ((): number => Date.now())
  // 窗口结束时刻；undefined 表示没有冷却。
  let openUntil: number | undefined
  // 窗口代次：每次开窗/续窗递增。请求开始时记录当时的代次，
  // 只有代次未变的成功才能关闭窗口，避免开窗前发出、开窗后才返回的迟到成功清掉新窗口。
  let windowGeneration = 0
  // 是否已有一次恢复探测在执行：并发请求据此判断「只允许一个真正探测」。
  let probing = false

  function unavailable (): SearchUnavailableError {
    return new SearchUnavailableError('搜索服务处于失败冷却窗口内。')
  }

  async function run<T> (call: () => Promise<T>): Promise<T> {
    const generation = windowGeneration
    const deadline = openUntil
    // 窗口已到期才允许探测；没有冷却时（deadline 为 undefined）走常规路径。
    const isProbe = deadline !== undefined && now() >= deadline
    if (deadline !== undefined && (!isProbe || probing)) {
      // 窗口内，或窗口已到期但探测在跑：直接不可用，不触达适配器、不等连接超时。
      // 检查与置位之间没有 await，因此同一事件循环内不会有两个请求同时成为探测者。
      throw unavailable()
    }
    if (isProbe) probing = true

    try {
      const result = await call()
      // 只有窗口代次未变的成功才关闭窗口；更早发出的迟到成功不能解除冷却。
      if (generation === windowGeneration) openUntil = undefined
      return result
    } catch (error) {
      if (error instanceof SearchUnavailableError) {
        // 可用性故障：开窗或续窗，并递增代次。程序错误不改变窗口，避免把 500 当成降级。
        windowGeneration += 1
        openUntil = now() + cooldownMs
      }
      throw error
    } finally {
      if (isProbe) probing = false
    }
  }

  return {
    search (query: ProductSearchQuery): Promise<ProductSearchResult> {
      return run(() => adapter.search(query))
    },
    suggest (query: ProductSuggestionQuery): Promise<ProductSuggestionResult> {
      return run(() => adapter.suggest(query))
    },
  }
}
