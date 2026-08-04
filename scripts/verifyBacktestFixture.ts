import {validateDeterministicBacktestFixture} from '@/lib/backtesting/parity/fixtureValidation';
async function main(){const report=await validateDeterministicBacktestFixture();console.error(`Backtest fixture verification: ${report.ok?'PASS':'BLOCKED'}`);console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=2;}
void main().catch(error=>{console.error(JSON.stringify({ok:false,error:String(error)}));process.exitCode=1});
