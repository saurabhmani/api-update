export class BacktestWorkerMetrics {
  private values = new Map<string, number>();
  set(name: string, value: number) { this.values.set(name, value); }
  inc(name: string, value = 1) { this.values.set(name, (this.values.get(name) ?? 0) + value); }
  render() { return [...this.values].map(([name, value]) => `quantorus_backtest_${name} ${value}`).join('\n') + '\n'; }
}
