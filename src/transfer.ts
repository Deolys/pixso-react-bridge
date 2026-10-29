import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPipeline, applyRun } from './pipeline.js';
import { acceptRun } from './accept.js';
import { writeJson } from './fs.js';
import type { BridgeConfig } from './types.js';

export async function runTransfer(snapshot: string, config: BridgeConfig, options: { iterations?: number; runDir?: string; resume?: boolean } = {}) {
  const iterations = options.iterations ?? 2;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5) throw new Error('Repair iterations must be between 1 and 5');
  const runDir = options.runDir ?? path.join(snapshot, 'runs', `transfer-${Date.now()}-${randomUUID().slice(0,8)}`);
  await mkdir(runDir,{recursive:true});
  const attempts: unknown[] = []; let repairReport: string | undefined;
  for(let iteration=1;iteration<=iterations;iteration++) {
    const iterationDir=path.join(runDir,`iteration-${iteration}`);
    const generated=await runPipeline(snapshot,config,{runDir:iterationDir,resume:options.resume,repairReport});
    if (generated.status === 'blocked-project-data') {
      const result={status:'blocked-project-data',complete:false,pixelPerfect:false,runDir,attempts:[...attempts,{iteration,generation:generated.status}],dataPlan:generated.dataPlan,reason:'Project mock tools, fixtures or data bindings are missing or unverified. Read data-gaps.md and prepare the scenario using the project tools; then rerun transfer. No generated files were applied.'};
      await writeJson(path.join(runDir,'transfer.json'),result); return result;
    }
    if (generated.status === 'blocked-design-system') {
      const result={status:'blocked-design-system',complete:false,pixelPerfect:false,runDir,attempts:[...attempts,{iteration,generation:generated.status}],componentPlan:generated.componentPlan,reason:'Design-system components are missing, need adaptation or could not be verified. Read component-gaps.md and use its AI task to update the library; then rerun transfer. No generated files were applied.'};
      await writeJson(path.join(runDir,'transfer.json'),result); return result;
    }
    if (!['awaiting-validation','generated-with-gaps'].includes(generated.status)) {
      const result={status:'failed',complete:false,runDir,attempts:[...attempts,{iteration,generation:generated.status}],reason:'GigaCode worker failure. Inspect task logs; use resume after fixing the CLI.'};
      await writeJson(path.join(runDir,'transfer.json'),result); return result;
    }
    await applyRun(iterationDir,config);
    const accepted=await acceptRun(iterationDir,config);
    attempts.push({iteration,runDir:iterationDir,acceptance:accepted.reportPath,status:accepted.status});
    if(accepted.status==='accepted') {
      const result={status:'accepted',complete:true,pixelPerfect:accepted.pixelPerfect,runDir,attempts,outputDir:config.generation.outputDir,report:accepted.reportPath};
      await writeJson(path.join(runDir,'transfer.json'),result); return result;
    }
    repairReport=accepted.reportPath;
  }
  const result={status:'failed',complete:false,runDir,attempts,reason:'Validation still fails after bounded repair attempts. All evidence is retained; no false completion.'};
  await writeJson(path.join(runDir,'transfer.json'),result); return result;
}
