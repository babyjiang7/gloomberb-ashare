# Privacy

The plugin adapts Shanghai and Shenzhen A-share search and display names inside Gloomberb. It does not add telemetry, an analytics account, or an upload service.

## Network requests

| Operation | Data sent | Destination |
| --- | --- | --- |
| Chinese name, pinyin, and initials search | A request for the issuer directory; matching runs locally | CNINFO |
| Current issuer verification | The security code | CNINFO |
| English name lookup | The security code through Gloomberb's native search or quote APIs | Gloomberb's configured market-data providers |
| Communication with the Python child process | Search text and security codes | `127.0.0.1` on the same computer |

Remote providers can observe these requests and the network information needed to deliver a response, such as the source IP address. Native provider requests use the host's provider configuration and policies. The plugin does not send holdings, position quantities, cost basis, watchlist names, or portfolio names to remote providers. This statement covers the plugin's requests; it does not describe unrelated Gloomberb features.

## Local data

The plugin reads security metadata and list membership to identify the A-share rows that need display names. It writes verified names and source records into the corresponding Gloomberb security metadata. Source records include the code, issuer identity, source URL, content hash where available, and local verification time. A local verification time is not a provider publication time or a quote timestamp.

The Python service stores issuer responses, bounded caches, and acquisition receipts in the plugin's runtime directory under the host data directory. These files may reveal which security codes were verified. The plugin does not publish them. The repository and release package contain no user profile, cached provider directory, authentication file, holdings export, or personal desktop screenshot.

## Child process and removal

The host starts one local Python service when a lookup needs it. Concurrent lookups share that service. The service listens only on `127.0.0.1`. It shuts down when the owning host closes its input pipe or when the plugin disposes it. The plugin uses bounded termination if normal shutdown does not finish.

Disabling or uninstalling stops the plugin's service and registrations. It does not automatically restore earlier display names. Saved names, source records, and NAME column settings remain in Gloomberb. Existing local caches and receipts may also remain in the host data directory. Removing the plugin's runtime directory after the host is closed removes those plugin caches and receipts; it does not remove source records saved in host security metadata.

## Bug reports

Use synthetic securities and positions when possible. Redact credentials, personal paths, account identifiers, list names, and holdings before sharing a log or screenshot. For a suspected vulnerability, follow [Security](SECURITY.md).
