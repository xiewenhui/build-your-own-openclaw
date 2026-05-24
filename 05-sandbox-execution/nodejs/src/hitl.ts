import readline from 'readline';

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

    // stdin is exclusively owned by HITL — no CLI adapter competing for it
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('Approve? [y/N] ', (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }
}
