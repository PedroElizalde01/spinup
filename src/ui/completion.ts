export type FlagSpec = {
  long: string;
  short?: string;
  description: string;
};

export type Shell = "bash" | "zsh" | "fish";

/**
 * Written for bash 3.2, which macOS still ships: no mapfile, no associative arrays.
 * The same function runs in zsh through bashcompinit.
 */
function bashScript(flags: FlagSpec[]): string {
  const words = flags.flatMap((flag) => [flag.long, ...(flag.short ? [flag.short] : [])]).join(" ");

  return `# spinup completion for bash. Load with:  eval "$(spinup --completion bash)"
# shellcheck disable=SC2207
_spinup_complete() {
  local cur prev command alias word
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[0]##*/}"
  alias=""

  # Through a generated command the alias is the command itself; otherwise it is
  # the first word that is not a flag or a flag's value.
  if [[ "\${command}" != "spinup" ]]; then
    alias="\${command}"
  else
    local index=1
    while (( index < COMP_CWORD )); do
      word="\${COMP_WORDS[index]}"
      case "\${word}" in
        -a|--action|--completion|--restart|--update) index=$((index + 2)); continue ;;
        -*) ;;
        *) alias="\${word}"; break ;;
      esac
      index=$((index + 1))
    done
  fi

  case "\${prev}" in
    -a|--action)
      COMPREPLY=($(compgen -W "$(spinup --complete actions \${alias:+"\${alias}"} 2>/dev/null)" -- "\${cur}"))
      return ;;
    --restart)
      COMPREPLY=($(compgen -W "$(spinup --complete services \${alias:+"\${alias}"} 2>/dev/null)" -- "\${cur}"))
      return ;;
    --completion)
      COMPREPLY=($(compgen -W "bash zsh fish" -- "\${cur}"))
      return ;;
  esac

  if [[ "\${cur}" == -* || -n "\${alias}" ]]; then
    COMPREPLY=($(compgen -W "${words}" -- "\${cur}"))
    return
  fi

  COMPREPLY=($(compgen -W "$(spinup --complete aliases 2>/dev/null)" -- "\${cur}"))
}

complete -F _spinup_complete spinup
for _spinup_alias in $(spinup --complete aliases 2>/dev/null); do
  complete -F _spinup_complete "\${_spinup_alias}"
done
unset _spinup_alias
`;
}

function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function fishScript(flags: FlagSpec[]): string {
  const lines = [
    "# spinup completion for fish. Load with:  spinup --completion fish | source",
    "function __spinup_alias",
    "    set -l words (commandline -opc)",
    "    if test (basename $words[1]) != spinup",
    "        echo (basename $words[1])",
    "        return",
    "    end",
    "    for word in $words[2..-1]",
    "        if not string match -q -- '-*' $word",
    "            echo $word",
    "            return",
    "        end",
    "    end",
    "end",
    "",
    "function __spinup_register -a command",
    "    complete -c $command -f",
    ...flags.map(
      (flag) =>
        `    complete -c $command -l ${flag.long.slice(2)}${flag.short ? ` -s ${flag.short.slice(1)}` : ""} -d ${fishQuote(flag.description)}`,
    ),
    "    complete -c $command -l action -s a -x -a '(spinup --complete actions (__spinup_alias))'",
    "    complete -c $command -l restart -x -a '(spinup --complete services (__spinup_alias))'",
    "    complete -c $command -l completion -x -a 'bash zsh fish'",
    "end",
    "",
    "__spinup_register spinup",
    "complete -c spinup -n 'test (count (commandline -opc)) -eq 1' -a '(spinup --complete aliases)'",
    "for alias in (spinup --complete aliases 2>/dev/null)",
    "    __spinup_register $alias",
    "end",
    "",
  ];

  return lines.join("\n");
}

/** Completion scripts ask spinup itself for aliases, actions and services, so they never go stale. */
export function completionScript(shell: Shell, flags: FlagSpec[]): string {
  switch (shell) {
    case "bash":
      return bashScript(flags);
    case "zsh":
      // zsh's bash compatibility layer runs the same function.
      return `# spinup completion for zsh. Load with:  eval "$(spinup --completion zsh)"\nautoload -U +X bashcompinit && bashcompinit\n${bashScript(flags).split("\n").slice(1).join("\n")}`;
    case "fish":
      return fishScript(flags);
  }
}
