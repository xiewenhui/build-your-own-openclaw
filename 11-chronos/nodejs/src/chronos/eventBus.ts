import { EventEmitter } from 'events';

export interface SystemEvent {
  type: 'CODE_COMMIT' | 'SYSTEM_ALERT' | 'SKILL_ERROR' | string;
  payload: Record<string, any>;
}

class AgentEventBus extends EventEmitter {
  emitEvent(event: SystemEvent): void {
    this.emit(event.type, event.payload);
  }
}

export const eventBus = new AgentEventBus();
