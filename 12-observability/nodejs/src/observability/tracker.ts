class ActiveTaskTracker {
  private count = 0;

  enter(): void { this.count++; }
  exit():  void { this.count = Math.max(0, this.count - 1); }
  hasActiveTasks(): boolean { return this.count > 0; }
}

export const activeTaskTracker = new ActiveTaskTracker();
