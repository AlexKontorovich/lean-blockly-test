# Blockly Game Test

[![GitHub license](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/leanprover-community/lean4web/blob/main/LICENSE)

This is an experimental repository exploring using the <a
href="https://developers.google.com/blockly">blockly library</a> as an
interface for constructing tactic proofs in Lean for pedagogical purposes.

It is derived from <a
href="https://github.com/leanprover-community/lean4web">Lean4Web</a>
and currently has content from Alex Kontorovich's <a
href="https://github.com/AlexKontorovich/RealAnalysisGame/">Real
Analysis course</a>.

## Installing and Running

Ensure that you have a recent nodejs, probably  `v25.6.1` should suffice.

```shell
git clone git@github.com:jcreedcmu/lean-blockly-test.git
npm install
pushd Projects/MathlibDemo/ && lake exe cache get && popd
npm start
# go to http://localhost:3000/ in a web browser
```
