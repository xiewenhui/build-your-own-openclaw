class MetricsCollector {
  private static instance: MetricsCollector;
  private registry = new Map<string, number[]>();

  private constructor() {}

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  record(name: string, value: number, tags: Record<string, string> = {}): void {
    if (!this.registry.has(name)) this.registry.set(name, []);
    this.registry.get(name)!.push(value);

    console.log(JSON.stringify({
      log_type:     'METRIC',
      metric_name:  name,
      metric_value: value,
      ...tags,
      timestamp: new Date().toISOString(),
    }));
  }

  percentile(name: string, p: number): number {
    const values = this.registry.get(name) ?? [];
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0;
  }

  summary(): Record<string, { p50: number; p95: number; count: number }> {
    const out: Record<string, { p50: number; p95: number; count: number }> = {};
    for (const [name, values] of this.registry) {
      out[name] = {
        p50:   this.percentile(name, 50),
        p95:   this.percentile(name, 95),
        count: values.length,
      };
    }
    return out;
  }
}

export const metrics = MetricsCollector.getInstance();
