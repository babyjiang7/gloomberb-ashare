# Changelog

## 0.9.0-alpha.1

First public Alpha, prepared from the locally accepted 0.8.11 name/search implementation.

- Chinese, full-pinyin, initial, and stock-code global search for Shanghai/Shenzhen ordinary equities.
- Verified handoff to original research and Add to Watchlist/Add to Portfolio flows.
- Chinese + English, Chinese, and English display modes for native table names, with source ownership and current-record protection.
- Bounded retry and mode-change cancellation to avoid publishing old name preferences.
- Removed retired financial, quote, announcement, PDF, sample-catalogue, and local-launcher modules from the public package.
- Reduced the Python runtime dependency to a hash-locked `pypinyin==0.55.0`.
- Added an explicit portable Python setup/check script and a standalone development configuration.

This Alpha needs the documented Python setup step after repository installation. It has not been submitted to the official plugin directory. Known limits and actual acceptance scope are documented in the README and validation notes.
