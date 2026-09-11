# Third-Party Notices — ComfyUI-AI-Helper

This file lists the third-party components that are **bundled (vendored) inside this
repository** or otherwise distributed with it, along with their applicable licenses.

ComfyUI-AI-Helper itself is licensed under the **GNU General Public License v3.0 or
later** (see `LICENSE`). The components listed below are covered by their own
permissive licenses, reproduced here as required by their terms.

> Note: the vendored builds of xterm.js and @xterm/addon-fit (`js/xterm.js`,
> `js/xterm-addon-fit.js`) are minified distribution builds whose embedded license
> headers were lost. This file restores the required license and copyright notices
> for them.

---

## 1. xterm.js

- **Vendored file:** `js/xterm.js`
- **Homepage:** https://xtermjs.org/
- **License:** MIT

```
Copyright (c) 2014-2024 The xterm.js authors. https://xtermjs.org/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 2. @xterm/addon-fit

- **Vendored file:** `js/xterm-addon-fit.js`
- **Homepage:** https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit
- **License:** MIT

```
Copyright (c) 2018-2022 The xterm.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 3. Python dependencies (installed via pip)

The Python packages below are declared in `requirements.txt` and installed into the
user's ComfyUI Python environment via pip. They are **distributed separately by their
respective authors through PyPI and are NOT vendored** in this repository; therefore no
copyrightable material from them is redistributed here. Their known licenses are listed
for information only.

| Package | Known license |
|---|---|
| spandrel | MIT |
| av (PyAV) | BSD-3-Clause |
| paramiko | LGPL-2.1-or-later |
| requests | Apache-2.0 |
| numpy | BSD-3-Clause |
| Pillow | MIT-CMU (HPND) |
| psutil | BSD-3-Clause |
| pywinpty | MIT |
| aiofiles | Apache-2.0 |
| orjson | Apache-2.0 OR MIT |
| watchdog | Apache-2.0 |
| python-xmp-toolkit | BSD-3-Clause |
| aiohttp | Apache-2.0 |
| pynvml | BSD-3-Clause |

For the exact license text of each package, refer to the package metadata
(`pip show <package>`) or its source repository at the version actually installed.
