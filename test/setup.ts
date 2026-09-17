// Test preload. The launch paths print progress with console.log ("[deps] resolving
// dependencies", "[tmux] session ... is ready"), which buried test results under
// dozens of lines. Assertions never read console.log: output checks go through
// child processes or process.stdout.write. Set SPINUP_TEST_VERBOSE=1 to see it.
if (!process.env.SPINUP_TEST_VERBOSE) {
  console.log = () => undefined;
}
