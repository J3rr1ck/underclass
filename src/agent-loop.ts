import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Thin wrapper around AgentSession that passes through to pi's native
 * session and tools. Pi handles context compaction automatically via
 * its event-driven compaction system.
 */
export class AutoCompactingSession {
  constructor(private session: AgentSession) {}

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  subscribe(listener: (event: any) => void) {
    return this.session.subscribe(listener);
  }

  async abort(): Promise<void> {
    return this.session.abort();
  }

  get agent() {
    return this.session.agent;
  }

  get model(): any {
    return this.session.model;
  }

  get messages() {
    return this.session.agent.state.messages;
  }

  dispose() {
    return this.session.dispose();
  }
}
