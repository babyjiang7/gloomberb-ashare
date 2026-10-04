# Alpha validation

Release: **0.9.0-alpha.1**. Checks were performed on **2026-10-05, Asia/Shanghai**. This file summarizes checks and links to cropped screenshots from a disposable public demo. Personal profiles, provider archives, personal desktop screenshots, and local process logs are not distributed.

## Reproducible checks

| Check | Result |
|---|---|
| Fresh published JavaScript dev dependencies | Bun 1.3.11; Gloomberb SDK 0.15.8; no adjacent checkout |
| Clean Python setup and read-only check | New virtual environment; hash-locked pypinyin 0.55.0; no market/finance dependencies |
| TypeScript tests | 103 passed, 0 failed, 836 assertions across 9 files |
| TypeScript typecheck | Passed with the repository's standalone tsconfig |
| Python tests | 46 passed in the new virtual environment |
| Official GitHub installation and removal | Passed with installed Gloomberb 0.15.8 in a fresh anonymous profile; Python setup/check, doctor 10/10, real service exit, and official removal |
| Source-only release audit | No runtime/profile/database/authentication files, personal paths, binary packages, or credentials in the allowlisted source tree |
| Public Alpha desktop demonstration | Actual macOS Watchlist and Main Portfolio bilingual tables, `gyfl` search with three native actions, and the official Setup options; disposable profile with synthetic holdings |

Tests cover issuer identity, ambiguous search, cancellation, finite retries, exact-key membership, custom-name ownership, fresh-position merging, legacy name migration, display-mode races, local service ownership, setup checks, and rejection of retired service routes.

Four executable fault-injection tests use POSIX shebang fixtures and are skipped on Windows. Missing-Python, real service startup, and parent-process ownership tests remain enabled there. A Python graceful-SIGTERM test is also POSIX-only. These exclusions are explicit; a passing platform job is not desktop or terminal end-to-end acceptance on that platform.

## Actual installed-host checks

The installed **Gloomberb 0.15.8** executable loaded this Alpha in a new anonymous disposable profile. No personal authentication or portfolio was copied into it.

After the repository was published, the official `install babyjiang7/gloomberb-ashare` command was also tested from another fresh profile. It fetched the published source, prepared a new Python environment, passed all ten doctor checks, and started the real local service. The service exited successfully when its input pipe closed. Official removal succeeded, and both installation-test profiles were deleted. All 49 tracked files matched the fetched commit throughout that check. Later documentation and public demo images do not change the runtime source or Alpha version/tag.

- `plugin doctor` passed, including the desktop browser bundle and declared hosts.
- Real CNINFO-backed searches for Chinese name, full pinyin, initials, and stock code returned the expected issuer candidate. Exact issuer verification was also exercised.
- Native company-name synchronization passed Chinese + English → English → Chinese → Chinese + English. English evidence came from the actual native Cloud source.
- Synthetic positions, collection membership, custom names, and a nonmember security were preserved. Retired financial/quote routes and capabilities were rejected.
- The tested installed-program and public runtime-source hashes remained unchanged. Test-owned profiles and process groups were removed after each completed run.

The first real source attempt encountered **CNINFO HTTP 504** during issuer verification. A fresh, bounded second attempt passed. The failed attempt was retained locally; no fabricated provider response replaced it. This is evidence of a temporary upstream outage, not a guarantee of continuous service.

## Native display acceptance

The local predecessor's macOS desktop Watchlist had already displayed six real Shanghai/Shenzhen rows in Chinese, English, and bilingual modes. The public Alpha keeps that search/name logic, with a smaller service/package. That predecessor check is distinct from this Alpha's anonymous installed-host checks.

### Public Alpha macOS desktop

On 2026-10-05, the actual installed Gloomberb 0.15.8 macOS app ran this public Alpha in a disposable demo profile with synthetic holdings. Native app inspection and screenshots verified:

- Both native Watchlist and Main Portfolio tables displayed bilingual names. The demo selected only TICKER and NAME; full names fitted the wide desktop layout shown in [the list screenshot](images/native-lists.jpg).
- Global `gyfl` search displayed 工业富联 with native research, Add to Watchlist, and Add to Portfolio actions, as shown in [the search screenshot](images/search-initials.jpg).
- Official `PL → A-share Support → Setup` displayed Chinese + English, Chinese, and English options in [the settings screenshot](images/name-settings.jpg). No setting was submitted during capture. This check does not claim that all three modes were switched in this desktop session.

The three public images are cropped actual-app screenshots. The demo profile was removed after capture. Post-capture protection checks found no changes to protected data in the ordinary profile; daily-plugin and installed-program files retained their hashes. The capture does not establish whole-market name coverage or acceptance against a normal personal portfolio.

### Terminal

The installed 0.15.8 terminal rendered both native Main Portfolio and Watchlist in an anonymous profile with synthetic holdings. NAME cells visibly showed `立讯精密 · Luxs…` and `工业富联 · Foxc…`, confirming the original 16-cell clipping behavior. These were actual native tables, not a duplicate plugin pane.

Actual global initials search showed the research and add actions. Selecting the add actions opened native `AW 601138:XSHG` and `AP 601138:XSHG` workflows; neither confirmation was submitted. Default research selection opened the original stock-research pane with the verified Shanghai issuer. The host created its expected MIC-keyed research record; all preexisting fixture holdings, custom names, memberships, and nonmember aliases remained unchanged.

This proves Alpha terminal rendering and native handoff in that synthetic profile. The separate desktop demonstration above covers the public Alpha's macOS UI; neither check establishes acceptance against a normal personal portfolio.

## Remaining scope

- macOS is the actual local acceptance platform. Windows/Linux checks have not run for this release; even a passing platform job would not establish desktop acceptance.
- The release does not certify all listed companies or all English names. Candidates are checked against current issuer identity when selected.
- Narrow layouts can clip long names in the original single-line NAME column; the terminal's default width is 16 display cells. Portfolio Grid labels stay stock codes.
- Live frontend name publication depends on a visible status bar.
- Actual provider publication time, market-price freshness, and financial data quality are outside these name/search checks.
- Original quote/calendar availability and automatic financial gap filling remain separate, unresolved features.

Cross-platform CI is provided as a [template](ci-template.yml). It is not active in this Alpha. To enable it, copy the template to `.github/workflows/ci.yml` in a repository with workflow publishing permission. Its tests use offline fixtures and setup checks; they do not query live CNINFO or use a personal Gloomberb profile.
