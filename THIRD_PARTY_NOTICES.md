# Third-party notices

FowlBrowser includes code and designs from these projects.

## Playwright

`mcp/src/vendor/browserModel.mjs` and `mcp/src/vendor/cdpRelay.mjs` are adapted from Playwright
(https://github.com/microsoft/playwright), Copyright (c) Microsoft Corporation, licensed under the Apache License,
Version 2.0. The files keep their original license headers; the full license text and Playwright's NOTICE are next to
them in `mcp/src/vendor/LICENSE` and `mcp/src/vendor/NOTICE`. The MCP server also depends on the `playwright-core`
package under the same license.

## Cua

The agent cursor in `mcp/src/cursor/overlay.js` follows the default cursor theme and `signature_arc` motion of Cua
(https://github.com/trycua/cua), including its arrow shape. Cua is licensed under the MIT License:

```
MIT License

Copyright (c) 2025 Cua AI, Inc.

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
