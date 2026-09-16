/**
 * When a service counts as ready for the services that depend on it. Without one,
 * a dependency is ready as soon as it has started (plus its delay).
 */
export type ReadyCondition =
  | { port: number; host?: string; timeout?: number }
  | { http: string; timeout?: number }
  | { log: string; timeout?: number }
  | { exit: 0; timeout?: number };

export type Task = {
  name: string;
  cwd: string;
  cmd: string;
  dependsOn?: string[];
  delay?: number;
  env?: Record<string, string>;
  ready?: ReadyCondition;
};

// Tasks and panes are the same shape; the names say which backend runs them.
export type Pane = Task;

export type Window = {
  name: string;
  layout?: string;
  panes: Pane[];
};

export type SimpleAction = {
  mode: "simple";
  tasks?: Task[];
};

export type TmuxAction = {
  mode: "tmux";
  windows: Window[];
};

export type Action = SimpleAction | TmuxAction;

export type SpinupConfig = {
  /** Config format version. Absent means 1. */
  version?: number;
  name: string;
  root: string;
  default: string;
  actions: Record<string, Action>;
};
