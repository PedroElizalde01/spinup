import { getProject, removeProject } from "../core/registry.ts";
import { removeShim } from "../core/shim.ts";

/**
 * The wrapper goes before the registry entry. Losing the entry while a runnable
 * wrapper remains would leave a command that launches nothing; a failed wrapper
 * removal leaves the registration in place, so the command can simply be retried.
 */
export async function removeRegisteredProject(alias: string): Promise<void> {
  const projectRoot = await getProject(alias);

  if (!projectRoot) {
    throw new Error(`Project "${alias}" is not registered.`);
  }

  const removedShim = await removeShim(alias);
  await removeProject(alias);

  console.log(`Removed project "${alias}" (${projectRoot})`);

  if (!removedShim) {
    console.log(`No generated command was found for "${alias}"; nothing else was deleted.`);
  }
}
