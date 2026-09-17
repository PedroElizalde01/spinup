# Quick start

## Register a project

From the project's directory:

```bash
spinup my-app
```

spinup scans the project, writes `.spinup.yml`, installs a `my-app` command and
registers the directory. Each service in the generated file has a comment saying
where its command came from.

To review what was detected before anything is written, use the guided setup:

```bash
spinup --init
```

## Look before launching

```bash
my-app --plan        # start order, directories, dependencies, readiness
my-app --doctor      # config, detection, tools, problems
my-app --check       # just the problems; exits 2 when the action cannot run
my-app --dry-run     # everything a launch resolves, including busy ports
```

## Launch

```bash
my-app
```

From any directory. A project with one service runs in the foreground with
prefixed output; with several, in a tmux workspace that you are attached to.

## Manage a tmux workspace

```bash
my-app --status
my-app --restart api
my-app --attach
my-app --stop
```

## Other actions

A generated config can contain several actions, such as `docker` or
`prisma-migrate`:

```bash
my-app --action prisma-migrate
```

## Try a config without registering

In any directory with a `.spinup.yml`:

```bash
spinup --start
```

Nothing is registered and no command is installed.
