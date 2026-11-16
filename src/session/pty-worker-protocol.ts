export interface PtySpawnOptions {
  command: string;
  args: string[];
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConptyDll?: boolean;
}

export type PtyWorkerRequest =
  | { type: "spawn"; options: PtySpawnOptions }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "kill"; signal?: string };

export type PtyWorkerEvent =
  | { type: "ready"; pid: number; cols: number; rows: number }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; message: string };
