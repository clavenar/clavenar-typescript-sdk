# Anthropic Computer Use + Clavenar

Computer Use ships three high-blast-radius tools — `computer`, `bash`,
and `str_replace_editor` — that can drive a real workstation. The
`clavenarWrap` recipe is unchanged: every action lands as a normal
`tool_use` block, so wrap-the-client gates each one before it
executes.

## Run it

```bash
npm install @anthropic-ai/sdk @vanteguardlabs/clavenar-ai-sdk
ANTHROPIC_API_KEY=sk-ant-... node --import tsx run.ts
```

## Policy

The integration is one line; what matters is what your Rego says.
A starting point that denies destructive `bash` commands and prod
file edits:

```rego
package clavenar.authz
import rego.v1

# Block destructive bash invocations outright.
deny contains msg if {
    input.params.name == "bash"
    cmd := lower(input.params.arguments.command)
    contains(cmd, "rm -rf")
    msg := sprintf("blocked destructive bash command: %s", [cmd])
}

# Park file edits under /etc, /var, or production paths for review.
review contains msg if {
    input.params.name == "str_replace_editor"
    path := input.params.arguments.path
    startswith(path, "/etc/")
    msg := sprintf("file edit under /etc requires review: %s", [path])
}
```

The recipe stub denies a `bash` call attempting `rm -rf /var/www/staging`
so the deny path is visible at first run.

## Three outcomes

- Green — allowed; the Anthropic response passes through, your handler
  dispatches the action.
- Red — `ClavenarDenied` thrown; reason surfaces in `e.reasons`.
- Yellow — `ClavenarPending` thrown; `await e.resolve()` blocks until an
  operator decides via `clavenarctl` or the console.

## See also

- `examples/native-anthropic/` — the same wrap, no computer-use tools
  registered.
- `policies/templates/prod_db_writes.rego` — companion template, same
  "deny by tool name + arg shape" pattern.
