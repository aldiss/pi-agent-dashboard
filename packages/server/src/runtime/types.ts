import type { ChildProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import type { ImageContent, MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface RuntimeSendInput {
  text: string;
  images?: ImageContent[];
  author?: MessageAuthor;
  queueNonce?: string;
}

export interface RuntimeEvent {
  eventType: string;
  timestamp: number;
  data: any;
}

export interface CodexAdapter {
  readonly runtime: "codex";
  readonly threadId: string;
  readonly threadPath?: string;
  readonly model?: string;
  readonly process: ChildProcess;
  readonly pid?: number;
  isStreaming(): boolean;
  send(input: RuntimeSendInput): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
