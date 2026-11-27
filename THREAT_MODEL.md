# Threat model

## Fork PR Cargo build cache

The `Fork PR check` runs contributor-controlled Rust and build inputs. The protected
asset is the integrity of the required PR check: a cache written by one untrusted PR
must not supply compiled artifacts to another PR.

The deployed runner cache is scoped to a repository, not a pull request. Its job
credential contains a repository identity, and cache lookup matches repository, key,
and version without a PR identity ([credential and lookup implementation](https://github.com/adambenhassen/runner/blob/02a6815c18f54670bf796d2b45d0a57714f5d3d8/act/artifactcache/handler.go#L46-L52), [lookup](https://github.com/adambenhassen/runner/blob/02a6815c18f54670bf796d2b45d0a57714f5d3d8/act/artifactcache/handler.go#L624-L658)). A toolchain and lockfile hash identifies build inputs, but does not establish who produced an archive. In particular, `target/release` contains compiled outputs that affect later build steps.

The fork PR workflow includes `github.event.pull_request.number` in the primary key before the OS, toolchain, and input hashes, and provides no `restore-keys`. The maintained workflow therefore restores only that PR's cache; another PR's key differs before any shared suffix. Cache saves use the same primary key. This retains reuse across runs of one PR while the toolchain and lockfile are unchanged. Release, deploy, and other privileged workflows must not restore caches written by this fork PR workflow.

This separation is enforced by the workflow's key convention, not by the runner cache server. A contributor who can change the workflow can request an arbitrary repository cache key. Treat fork PR caches as untrusted and do not use them as trusted producer artifacts; server-enforced PR/ref scoping would be required to protect against a malicious workflow deliberately selecting another PR's key.
