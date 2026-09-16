export type Task = {
  name: string;
  cwd: string;
  cmd: string;
  dependsOn?: string[];
  delay?: number;
  env?: Record<string, string>;
};

export type Pane = {
  name: string;
  cwd: string;
  cmd: string;
  dependsOn?: string[];
  delay?: number;
  env?: Record<string, string>;
};

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
