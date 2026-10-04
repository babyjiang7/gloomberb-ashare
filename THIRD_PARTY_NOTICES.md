# Third-party notices

The plugin's original code is licensed under [MIT](LICENSE). This release contains plugin source and tests. It does not bundle Gloomberb, third-party Python packages, wheels, or fetched provider datasets.

## Gloomberb

The plugin uses Gloomberb's public plugin APIs and test support. Gloomberb remains a separately installed host application.

- Project: [gloom-sh/gloomberb](https://github.com/gloom-sh/gloomberb)
- License: [MIT](https://github.com/gloom-sh/gloomberb/blob/main/LICENSE)
- Upstream copyright: Copyright (c) 2026 Gloomberb Contributors

The MIT license permits use, modification, and redistribution. Copies or substantial portions of upstream software must retain its copyright and permission notice. Its warranty disclaimer also applies to that software. This independent plugin is not an official Gloomberb release.

## pypinyin

The local Python service uses `pypinyin` to derive full pinyin and initials for search. The package is installed separately. Generated pinyin is a search aid, not proof of a company's identity.

- Project: [mozillazg/python-pinyin](https://github.com/mozillazg/python-pinyin)
- License: [MIT](https://github.com/mozillazg/python-pinyin/blob/master/LICENSE.txt)
- Upstream copyright: Copyright (c) 2016 mozillazg, 闲耘

The MIT license permits use, modification, and redistribution. Copies or substantial portions of the package must retain its copyright and permission notice. Its warranty disclaimer also applies to that package.

## Provider data

Chinese issuer information comes from [CNINFO](https://www.cninfo.com.cn/). English names come from Gloomberb's configured native market-data providers. The plugin's MIT license does not grant rights to provider data, names, logos, or trademarks. Access and reuse remain subject to the relevant provider's terms.

This repository does not redistribute downloaded issuer directories, raw provider responses, or a company-name database. Source URLs and local verification times are retained when the plugin runs so users can check the origin of a displayed name.

Upstream license references were checked on 2026-10-05. If a future distribution bundles upstream code or dependencies, it must include their complete applicable license notices rather than relying on these summaries.
