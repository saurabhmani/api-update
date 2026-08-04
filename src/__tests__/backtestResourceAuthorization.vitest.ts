import fs from 'node:fs';
import path from 'node:path';
import { describe,expect,it } from 'vitest';

const root='src/app/api/backtests';
const routes=[
  'route.ts','compare/route.ts','process-queue/route.ts','seed-data/route.ts','[id]/route.ts','[id]/analytics/route.ts','[id]/audit/route.ts','[id]/calibration/route.ts','[id]/cancel/route.ts','[id]/dexter/route.ts','[id]/export/route.ts','[id]/performance/route.ts','[id]/signals/route.ts','[id]/trades/route.ts',
];
describe('Backtest public resource authorization architecture',()=>{
  it('inventories 14 route files and 18 HTTP methods',()=>{
    expect(routes.every(file=>fs.existsSync(path.join(root,file)))).toBe(true);
    const count=routes.reduce((sum,file)=>sum+(fs.readFileSync(path.join(root,file),'utf8').match(/export async function (GET|POST|DELETE|PUT|PATCH)/g)?.length??0),0);
    expect(count).toBe(18);
  });
  it('guards every route with session/admin or scoped parent authorization',()=>{
    for(const file of routes){const source=fs.readFileSync(path.join(root,file),'utf8'); expect(source, file).toMatch(/requireSession|requireAdmin|authorizeBacktestRoute/);}
  });
  it('requires scoped operations for list, delete, export, compare, detail, and children',()=>{
    expect(fs.readFileSync(path.join(root,'route.ts'),'utf8')).toContain('listBacktestsForActor');
    const detail=fs.readFileSync(path.join(root,'[id]/route.ts'),'utf8'); expect(detail).toContain('deleteBacktestForActor'); expect(detail).toContain('authorizeBacktestRoute');
    for(const child of ['analytics','audit','calibration','dexter','export','performance','signals','trades']) expect(fs.readFileSync(path.join(root,`[id]/${child}/route.ts`),'utf8'),child).toContain('authorizeBacktestRoute');
    expect(fs.readFileSync(path.join(root,'compare/route.ts'),'utf8')).toContain('getBacktestForActor');
  });
  it('does not expose ID-only delete or cancellation functions to routes',()=>{
    const source=routes.map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');
    expect(source).not.toMatch(/cancelBacktestRun\s*\(/); expect(source).not.toMatch(/DELETE FROM backtest_runs/);
  });
});
