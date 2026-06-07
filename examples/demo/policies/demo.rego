# @clavenar/agent-sdk demo policy.
#
# Loaded by clavenar-lite via `--policies examples/demo/policies`. Same
# `clavenar.authz` package as the default governance.rego, so partners
# can see the canonical "ship your own rules alongside the defaults"
# pattern. Three rules cover the three tiers:
#
#   - delete_user: hard-deny.  → 403, ClavenarDenied (red).
#   - transfer_funds: review.  → 202, ClavenarPending, await resolve() (yellow).
#   - everything else:         → 200 (green, fetch_user, list_users, …).

package clavenar.authz

import rego.v1

default allow := false

# Hard-deny destructive user mutations. Real partners would scope
# this to a tenant or an agent role; the demo keeps it global so the
# reason string is easy to read on screen.
deny contains msg if {
	input.tool_type == "delete_user"
	msg := "Violation: delete_user is a destructive operation — block by default, require an explicit allowlist."
}

# Yellow tier — high-value money moves park for human review. Pairs
# with ClavenarPending + await resolve() on the SDK side: the partner's
# operator (or, in the demo, the auto-approver in run.ts) flips the
# pending via POST /pending/{correlation_id}/decide.
review contains msg if {
	input.tool_type == "transfer_funds"
	msg := "Review: transfer_funds requires human approval before execution."
}

# allow iff no deny rule fired.
allow if {
	count(deny) == 0
}
