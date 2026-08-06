/**
 * Filter attrition diagnostic — counts how many rows each read filter removes.
 * Safe for production: no row payloads / secrets.
 */
export interface FilterAttritionStep {
  filter: string;
  before: number;
  after: number;
  removed: number;
}

export function recordFilterStep(
  steps: FilterAttritionStep[],
  filter: string,
  before: number,
  after: number,
): void {
  steps.push({
    filter,
    before,
    after,
    removed: Math.max(0, before - after),
  });
}

export function summarizeFilterAttrition(steps: FilterAttritionStep[]): {
  input: number;
  output: number;
  steps: FilterAttritionStep[];
} {
  const input = steps[0]?.before ?? 0;
  const output = steps.length ? steps[steps.length - 1]!.after : 0;
  return { input, output, steps };
}
