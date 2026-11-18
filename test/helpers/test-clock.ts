/**
 * 可注入的假时钟（#24）：冷却窗口按毫秒推进，测试不真等 5 秒。
 *
 * 冷却状态归应用实例所有，时钟由应用工厂的 `searchCooldown.now` 注入，
 * 因此同一个应用实例上的所有请求共享这一份时间。
 */
export class TestClock {
  private current: number

  constructor (start = 0) {
    this.current = start
  }

  /** 交给应用工厂的时钟函数；每次调用都读当前值。 */
  readonly now = (): number => this.current

  /** 推进时间（毫秒）：用于让冷却窗口到期。 */
  advance (ms: number): void {
    this.current += ms
  }
}
