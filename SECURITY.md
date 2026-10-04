# Security

This project is an Alpha plugin. Security fixes target the latest Alpha release. Backports to older releases are not guaranteed.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option in this repository's Security tab if that option is available. Otherwise, contact [the maintainer through GitHub](https://github.com/babyjiang7) to arrange a private reporting channel. Private vulnerability reporting availability depends on the repository's GitHub settings.

Do not publish credentials, authentication files, holdings, personal paths, or unredacted profile data in an issue. Do not post exploit details in a public issue before a private reporting channel is agreed.

A useful report includes the plugin version, Gloomberb version, operating system, affected operation, expected behavior, and a minimal reproduction using synthetic data. Include only the files or log lines needed to reproduce the problem.

## Runtime scope

The plugin uses Gloomberb's public APIs. It does not patch the installed host application. The Python service runs as a child process and listens on `127.0.0.1` at a selected local port. It is not exposed on a public network interface. Other programs running on the same computer may access a loopback service; loopback is not an authentication boundary.

Disabling or removing the plugin stops its service and registrations. Saved display names, source records, and NAME column settings remain in Gloomberb. See [Privacy](PRIVACY.md) for local data and network requests.
