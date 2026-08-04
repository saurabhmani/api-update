import { MysqlBacktestOwnershipAuthority } from '@/lib/backtesting/queue/ownershipAuthority';
import type { BacktestProcessorOwner } from '@/lib/backtesting/queue/ownership';

const args=process.argv.slice(2); const command=args[0]??'show'; const flag=(name:string)=>args.includes(name); const value=(name:string)=>{const at=args.indexOf(name);return at>=0?args[at+1]:args.find(v=>v.startsWith(`${name}=`))?.slice(name.length+1)};
async function main(){
  const authority=new MysqlBacktestOwnershipAuthority(); const current=await authority.read(); const activeJobs=await authority.activeRuns();
  if(command==='show'){const report={ok:true,command,state:current,activeJobs};console.error(`Backtest ownership: ${current.owner} epoch=${current.epoch}; active=${activeJobs.reduce((n,r)=>n+Number(r.count),0)}`);console.log(JSON.stringify(report,null,2));return;}
  if(command!=='transition')throw new Error('Usage: backtest:ownership -- show | transition --to <disabled|service|monolith> --expected-epoch <n> --operator <id> [--execute]');
  const next=value('--to') as BacktestProcessorOwner; const expected=Number(value('--expected-epoch')); const operator=value('--operator')??''; const execute=flag('--execute');
  if(!['monolith','service','disabled'].includes(next))throw new Error('--to must be monolith, service, or disabled');
  if(!Number.isSafeInteger(expected)||expected<=0)throw new Error('--expected-epoch must be a positive integer');
  if(execute&&!operator.trim())throw new Error('--operator is required with --execute');
  const planned=await authority.transition(expected,next,operator||'dry-run-operator',!execute); const report={ok:true,command,dryRun:!execute,from:current,to:planned,activeJobs};
  console.error(`${execute?'Executed':'Dry-run'}: ${current.owner}@${current.epoch} -> ${planned.owner}@${planned.epoch}; safe=true`);console.log(JSON.stringify(report,null,2));
}
void main().catch(error=>{console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)},null,2));process.exitCode=2});
