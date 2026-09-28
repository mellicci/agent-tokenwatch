# Security policy

## Supported version

The current `0.1.x` line receives security fixes.

## Reporting

Report privately through GitHub's [private vulnerability
reporting](https://github.com/mellicci/agent-tokenwatch/security/advisories/new)
on this repository. That channel is visible only to the maintainers.

Do not open a public issue, and do not attach prompts, source code,
credentials, transcripts, local paths, raw hook payloads, or event files. A
minimal reproduction is enough. Expect an initial response within seven days.

## Local security posture

Tokenwatch is intentionally local and dependency-free. It still processes
untrusted JSON supplied by agent hooks and a loopback HTTP receiver. The code:

- caps stdin and OTLP request sizes;
- allowlists persisted fields;
- discards arbitrary OpenTelemetry bodies;
- binds OTLP to loopback by default;
- writes private state/config/data files with owner-only permissions where the
  platform supports POSIX modes;
- uses absolute executable paths in installed commands;
- never executes content from a hook payload;
- relays a pre-existing Codex notifier only from the local installation record.

Do not bind the OTLP receiver to a public interface without authentication,
firewalling, and a clear retention policy. Treat local configuration and install
state as sensitive because they contain filesystem integration paths even though
event records do not.
