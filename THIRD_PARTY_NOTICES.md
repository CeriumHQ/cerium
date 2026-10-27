# Third-party notices

Cerium is licensed under the Apache License 2.0 (`LICENSE`). It bundles the fonts, icons and marks
below, each under its own license, which takes precedence over Cerium's for that work.

The npm packages the backend runs ship inside the app (under `resources/app/node_modules`), each with
its own license file, and Electron's and Chromium's licenses ship with it as `LICENSE.electron.txt`
and `LICENSES.chromium.html`.

## Fonts

Shipped in the app, the web client and the website as web fonts, under the SIL Open Font License
1.1 (below). Cerium uses them unmodified, as packaged by [Fontsource](https://fontsource.org).

| Font         | Copyright                                                                                 | Used in                     |
| ------------ | ----------------------------------------------------------------------------------------- | --------------------------- |
| Anybody      | Copyright 2020 The Anybody Project Authors (https://github.com/Etcetera-Type-Co/Anybody)  | App, site                   |
| Red Hat Text | Copyright 2024 The Red Hat Project Authors (https://github.com/RedHatOfficial/RedHatFont) | App, artifacts, relay, site |
| Red Hat Mono | Copyright 2024 The Red Hat Project Authors (https://github.com/RedHatOfficial/RedHatFont) | App, artifacts, site        |

## Icons and marks

- **Material Icon Theme** (file and folder icons, `apps/ui/src/components/fileIcons/svgs.ts`):
  Copyright (c) 2025 Material Extensions, https://github.com/material-extensions/vscode-material-icon-theme.
  MIT License (below).
- **LobeHub Icons** (the harnesses' marks in the app and on the website,
  `apps/ui/src/components/ProviderLogo.tsx`, `apps/ui/src/assets/providers/`): Copyright (c) 2023
  LobeHub, https://github.com/lobehub/lobe-icons. MIT License (below).
- **Lucide** (the app's interface icons, through `lucide-react`): Copyright (c) 2026 Lucide Icons and
  Contributors, https://lucide.dev. ISC License (below). Some Lucide icons derive from Feather,
  Copyright (c) 2013-present Cole Bemis, under the MIT License (below).
- **Simple Icons** (the Apple and Linux marks on the website): CC0 1.0, https://simpleicons.org.

The harnesses' logos, Apple's, Windows' and Tux identify those products and remain trademarks of
their owners. Cerium is not affiliated with or endorsed by them.

## The website's scripts

The website (`apps/site`) bundles three.js, Copyright © 2010-2026 three.js authors, https://threejs.org,
and Lenis, Copyright (c) 2024 darkroom.engineering, https://github.com/darkroom-engineering/lenis, both
under the MIT License (below); and GSAP with its ScrollTrigger plugin, Copyright GreenSock, Inc.,
https://gsap.com, under GSAP's Standard "no charge" license, https://gsap.com/standard-license.

## SIL Open Font License 1.1

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## MIT License

Applies to Material Icon Theme, LobeHub Icons, the Feather-derived Lucide icons, three.js and Lenis,
each with its copyright line above.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License

Applies to Lucide, with its copyright line above.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
