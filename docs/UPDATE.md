# XyneX Panel — Update notes

## Install
From the panel project root:

    bash install.sh            # apply and build
    bash install.sh --push     # apply, build, commit and push
    bash install.sh --no-build # apply only

The installer locates the project root automatically, retires the replaced
`IntegrationsManager.tsx` into `.xynex-backup/` (never deleted), installs
dependencies if missing, builds, and optionally pushes. A push only happens
after a successful build.

## Contents
See `USERS_PAGE_CHANGES.md` for the full list of changes.
