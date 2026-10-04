# Gloomberb A-share Support

[简体中文](README.zh-CN.md)

**Alpha release.** Shanghai/Shenzhen company search and bilingual names inside Gloomberb's native interface. This is an independent community plugin. It does not modify the installed Gloomberb client.

## Features

| Feature | Behavior |
|---|---|
| Global company search | Search by Chinese name, full pinyin, pinyin initials, or stock code. Select a verified candidate to open native research. Ambiguous initials keep multiple candidates. |
| Native add flows | A candidate can open the original Add to Watchlist or Add to Portfolio flow with the stock code filled in. The original confirmation still applies. |
| Native table names | Eligible Shanghai/Shenzhen equities in a configured Watchlist or Portfolio receive verified Chinese and English names. Choose Chinese + English, Chinese, or English in plugin Setup. |
| Name protection | Preserve stock keys, exchange, currency, positions, collection membership, unrelated metadata, and custom names without verified source ownership. |

Chinese issuer names come from CNINFO. English names come from a matching native Cloud/Yahoo quote or exact-code search result. The plugin verifies the stock code, exchange, CNY currency, and equity type. It does not translate names. Missing English falls back to verified Chinese.

The release contains no independent research pane, quote provider, financial-statement provider, announcement/PDF service, or sample-company whitelist.

## Requirements

- Gloomberb **0.15.8 or newer**. The actual installed-host baseline tested for this release is 0.15.8.
- Python **3.10 or newer**, with `venv` and `pip`. The setup script installs one Python dependency: `pypinyin==0.55.0` with SHA-256 verification.
- Git for Gloomberb's repository installer. Bun is required when the host installer requests it.

macOS desktop is the primary acceptance platform. Windows and Linux path handling is included, but their desktop/terminal end-to-end behavior is experimental until independently tested. The hosted browser version is not supported.

## Install

1. Install the plugin with the official CLI:

   ```sh
   gloomberb install babyjiang7/gloomberb-ashare
   ```

2. Run `gloomberb plugins` and locate the installed `gloomberb-ashare` directory. On a standard macOS profile, prepare its Python environment:

   ```sh
   python3 ~/.gloomberb/plugins/gloomberb-ashare/scripts/setup-python.py
   python3 ~/.gloomberb/plugins/gloomberb-ashare/scripts/setup-python.py --check
   ```

   On Windows, use `py -3` with the installed script path. On Linux or with a custom `GLOOMBERB_HOME`, use the directory printed by `gloomberb plugins`. `--check` does not install packages or make network requests. The script does not install or upgrade Python.

3. Restart Gloomberb. Open `PL`, select **A-share Support**, enable it if disabled, and use **Setup** for name display preferences. Leave **Python executable** blank to use the plugin's `.venv`. A custom executable must be an absolute path with the locked dependency installed.

4. Check the plugin with:

   ```sh
   gloomberb plugin doctor gloomberb-ashare
   ```

Publishing the repository does not add it to the official Available directory. This Alpha is installed from its GitHub repository. Gloomberb's unlisted-plugin installer follows the repository default branch, so that branch is kept on the published Alpha code.

The official plugin installer does **not** run the Python setup step. An enabled plugin without its Python environment can load but cannot perform CNINFO searches or issuer verification. Run setup before using it. Do not install this beside another linked copy with the same `ashare-local` plugin ID.

## Use

1. Open global search: `Cmd+K` on desktop, `Ctrl+P` in the terminal.
2. Enter `工业富联`, `gongyefulian`, `gyfl`, or `601138`.
3. Select a company to open native research, or select its native add action.
4. In `PL → A-share Support → Setup → Name display / 名称显示`, choose the name mode. The default is **Chinese + English / 中英文**.

Stock codes stay in the original TICKER field. This plugin does not make the input fields inside Watchlist or Portfolio accept Chinese/pinyin; those fields still use the host's existing parser.

## Known limits

- Native NAME is a single line. Long English names are clipped. The terminal's default NAME width is 16 display cells. The public plugin API does not provide a two-line name or a native NAME width override.
- Portfolio Grid labels remain stock codes. The name mode changes the shared native table name field and can therefore affect other views that use it.
- Live frontend name publication and automatic NAME-column selection depend on the native status bar being visible. Existing saved names remain when it is hidden.
- Startup, new members, and mode changes trigger finite work. Failed requests get one bounded retry. There is no continuous full-market polling.
- A directory match is a candidate, not proof of a current listing. The selected issuer is checked again. Upstream availability and English-name coverage are not guaranteed for every company.
- Beijing Stock Exchange, funds, bonds, and overseas securities are outside this release's adaptation scope.
- Original LAST/CHG%/AGE availability is controlled by Gloomberb and its providers. This plugin does not fix the separate quote freshness/calendar issue reported in [upstream issue #1340](https://github.com/gloom-sh/gloomberb/issues/1340).
- There is no automatic native financial gap filling in this release.

## Update, disable, and remove

1. Update explicitly with `gloomberb update gloomberb-ashare`. Restart after an update, then rerun the Python setup/check if the release notes require it.
2. Disable **A-share Support** in `PL` to stop its registrations, pending work, and owned Python service.
3. Remove it in `PL` or run `gloomberb remove gloomberb-ashare`.

Saved names, provenance, and native NAME-column settings remain after disable/removal. The plugin does not automatically restore old names or delete stock records. Positions and collection membership belong to Gloomberb.

## Development

The repository is self-contained; no adjacent Gloomberb checkout is needed. Dev dependencies use the published 0.15.8 SDK.

```sh
bun install --frozen-lockfile --ignore-scripts
python3 scripts/setup-python.py
bun run typecheck
bun run test
# POSIX
.venv/bin/python -m unittest discover -s tests -v
# Windows: .venv\Scripts\python.exe -m unittest discover -s tests -v
```

Use an empty disposable `GLOOMBERB_HOME` for host integration checks. Do not run development fixtures against a personal portfolio. [Validation](docs/validation.md) records the actual release checks and their limits.

## Privacy and license

See [Privacy](PRIVACY.md), [Security](SECURITY.md), and [Third-party notices](THIRD_PARTY_NOTICES.md). The plugin code is [MIT licensed](LICENSE). This license does not grant rights to provider data. Do not include personal holdings, credentials, or local logs in public bug reports.
