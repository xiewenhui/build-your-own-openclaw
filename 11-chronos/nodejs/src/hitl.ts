import readline from 'readline';

const CONFIRM_TIMEOUT_MS = 30_000;

export interface HITLConfirmer {
  confirm(action: string, detail: string, destructive: boolean): Promise<boolean>;
}

export class CLIConfirmer implements HITLConfirmer {
  private autoApproveReads: boolean;

  constructor(autoApproveReads: boolean) {
    this.autoApproveReads = autoApproveReads;
  }

  async confirm(action: string, detail: string, destructive: boolean): Promise<boolean> {
    if (!destructive && this.autoApproveReads) {
      return true;
    }

    process.stderr.write(`\n[HITL] ${action}\n`);
    if (detail) process.stderr.write(`${detail}\n`);

    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

      const timer = setTimeout(() => {
        rl.close();
        process.stderr.write('\n[HITL] timeout — denied\n');
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      rl.question(`Approve? [y/N] (timeout ${CONFIRM_TIMEOUT_MS / 1000}s, default N) `, (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }
}
