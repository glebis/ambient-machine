# Contributing to Ambient machine

Thanks for your interest in improving it.

## Ways to contribute

- **Report a bug**: open an issue with your browser, OS and steps to reproduce.
- **Suggest a feature**: open an issue describing what you want to play.
- **Send a pull request** for fixes and features (see below).

## Development setup

There is no build step and no dependencies beyond Python 3.

```sh
git clone https://github.com/glebis/ambient-machine.git
cd ambient-machine
python3 server.py          # http://localhost:8781
```

Edit `engine.js`, `ui.js` or `style.css` and reload; the server sends `no-cache`.
To rebuild the bundled sample sets you need `numpy` and `scipy`:
`python3 tools/earcons/generate.py`.

Before submitting:

```sh
node --check engine.js && node --check ui.js
python3 -m py_compile server.py
```

Then try it in a browser: sounds load, slots launch, the drum machine plays.

Don't commit drums you generated locally (`sounds/drums/generated/` is ignored);
revert the matching entries in `sounds/drums/manifest.json` too.

## Pull requests

1. Fork and branch off `main`.
2. Keep changes focused: one logical change per PR.
3. Describe the *why* in the PR body, not just the *what*.

## Licensing of contributions

Unless you state otherwise in writing, contributions intentionally submitted for
inclusion are accepted under the project's [Apache-2.0](LICENSE) terms.

By contributing, you certify that you have the right to submit the work and that
it does not include code or audio copied from unlicensed, source-available,
non-commercial, GPL, AGPL, LGPL, or otherwise incompatible sources.

AI-assisted contributions are allowed, but generated output must be reviewed as
source code, not pasted blindly. When a contribution is substantially AI-assisted,
mention the tool and the human review performed in the PR description.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
