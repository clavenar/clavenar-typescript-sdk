# @warden/ai-sdk demo policy.
#
# Loaded by warden-lite via `--policies examples/demo/policies`. Same
# `warden.authz` package as the default governance.rego, so partners
# can see the canonical "ship your own rules alongside the defaults"
# pattern. For the screencap we only need two rules:
#
#   - delete_user: hard-deny. The "blocks the destructive call" path.
#   - everything else (fetch_user, list_users, ...): allowed.

package warden.authz

import rego.v1

default allow := false

# Hard-deny destructive user mutations. Real partners would scope
# this to a tenant or an agent role; the demo keeps it global so the
# reason string is easy to read on screen.
deny contains msg if {
	input.tool_type == "delete_user"
	msg := "Violation: delete_user is a destructive operation — block by default, require an explicit allowlist."
}

# warden-lite queries data.warden.authz.review even when no review-tier
# rules apply. Define a never-firing baseline so the rule path exists;
# real review rules (e.g., wire_transfer in the default governance.rego)
# get added the same way.
review contains msg if {
	false
	msg := "unreachable"
}

# allow iff no deny rule fired.
allow if {
	count(deny) == 0
}
