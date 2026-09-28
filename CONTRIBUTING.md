# Contributing

Agent Tokenwatch is maintained by one person, on a best-effort basis. That
shapes what kind of help is most useful.

## Issues are welcome

Bug reports, questions, and ideas are all welcome as
[issues](https://github.com/mellicci/agent-tokenwatch/issues/new/choose).

The most useful bug report says which agent CLI and version you ran, on which
operating system and Node.js version, what you did, what you expected, and what
happened instead. `tokenwatch doctor` output is usually the fastest way to show
your setup.

Tokenwatch exists so that prompts and code never leave your machine, so please
keep it that way in reports too: do not paste prompts, source code, transcripts,
credentials, local paths, raw hook payloads, or event files. A minimal
reproduction is enough.

Security issues go through
[private vulnerability reporting](https://github.com/mellicci/agent-tokenwatch/security/advisories/new),
never a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests are not accepted

This repository does not take code contributions, and pull requests will be
closed without review. That is about capacity, not about the quality of the
work: reviewing, testing, and then maintaining someone else's change properly
costs more time than there is.

If you have a fix or an improvement, open an issue that describes it instead. A
good idea may be implemented independently, and the issue is credited in the
changelog when it is. Forks are welcome under the [MIT License](LICENSE).

## What the project will not change

Ideas are judged against the constraints that keep Tokenwatch's trust surface
small. Suggestions that would break one of these are unlikely to be taken up:

- no runtime dependencies without a documented security and portability case;
- no persistence of prompts, code, transcripts, paths, commands, tool content,
  arbitrary attributes, or arbitrary telemetry bodies;
- no bundled model pricing;
- no unsupported savings claims;
- hooks must fail open for the coding agent;
- settings changes must be reversible and covered by a temporary-home round-trip
  test;
- new agent fields require a primary-documentation reference and a fixture that
  proves excluded text is not persisted. A session-file mapping
  (`src/import/mappings/`) is the exception: those formats are undocumented, so
  its evidence is a probe date and an agent version, recorded in the mapping's
  `evidence` block. A user's repaired mapping (`tokenwatch import <agent>
  --export-mapping`) may be shared in an issue as data. It holds key paths and
  ids, never a value or a path from their machine. Its fixtures follow the real file's key paths, with every
  value synthetic and poisoned.

## Working on a fork

```sh
npm run check          # syntax check, full test suite, smoke test
npm pack --dry-run     # what would be published
```

For interface changes, update `docs/interfaces.md` with the review date and
primary source. Keep generated commands cross-platform and avoid invoking a
shell with payload-controlled text.
