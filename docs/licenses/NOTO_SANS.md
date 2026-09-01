# Noto Sans S5 PDF asset

The S5 PDF renderer embeds the variable Noto Sans font from the official Noto
Fonts repository. The source is pinned to commit
`ffebf8c1ee449e544955a7e813c54f9b73848eac` and the exact upstream path is
`unhinted/variable-ttf/NotoSans-VF.ttf`.

- Source: https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/unhinted/variable-ttf/NotoSans-VF.ttf
- Upstream Git blob: `d9fe18ea79cf15c46024ffc1928c624780658d53`
- Local asset: `src/assets/fonts/NotoSans-VF.ttf`
- Local SHA-256: `2af0393ceff5554cbcd6a51a017046f624525046cb0a218f5c7f94fe2324d673`
- Upstream license blob: `c82d72e422e2d08c5ab439b6bac7c2177ea0c565` (`LICENSE`)
- Verbatim license evidence: `docs/licenses/NotoSans-OFL-1.1.txt`
- Local license SHA-256: `3c05a56499a20ee045a6d36834b6a9e1108f359eede10d7c1613bc4524d01eef`

The copied licence evidence is the upstream SIL Open Font License, Version
1.1 text at the same pinned commit. The renderer rejects the font if the
embedded bytes do not match the recorded SHA-256.
