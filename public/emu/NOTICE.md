# Licence notice for the Amiga feature

The Amiga emulator in this folder's `vendor/copperline/` is **Copperline**, copyright its authors,
licensed **GPL-3.0-or-later**: https://github.com/CopperlineHQ/Copperline (release v1.0.0).
Its licence text is `vendor/copperline/COPPERLINE-LICENSE`; credits are in `COPPERLINE-CREDITS.md`.
`vendor/copperline/VERSION.json` records the exact source commit that was built.

The AROS replacement ROM in `vendor/copperline/aros/` has its own licence (`aros/LICENSE`, `aros/ACKNOWLEDGEMENTS`).

The files in `public/emu/*.js` are also GPL-3.0-or-later (see their headers), because they are distributed to the
browser together with, and drive, the emulator. Anyone who is sent this app may ask for its source: publish it,
including `public/emu/`, `tools/build-copperline.mjs` and the rest of the front end.

No Kickstart ROMs or game disks are included, and none should be added unless you have the right to distribute them.
"Amiga" and "Commodore" are trademarks of their owners; do not use them in a product name.

# Licence notice for the Arcade feature

The arcade option uses **EmulatorJS** (GPL-3.0, https://github.com/EmulatorJS/EmulatorJS), with the **MAME 2003-Plus**
and **FinalBurn Neo** cores compiled to WebAssembly. They are downloaded by `tools/fetch-ejs.mjs` into
`public/emu/vendor/ejs/` (licence text: `LICENSE-EmulatorJS.txt`; exact versions: `ARCADE-VERSION.json`) and are not part of
this repository. The MAME-derived and FinalBurn Neo cores carry their own **non-commercial** licences: do not use this
feature in a commercial service. The host files `arcade-host.js`, `arcade-session.js` and `arcade-controls.js` are
GPL-3.0-or-later like the rest of `public/emu/`.

No arcade ROMs are included. Arcade games are copyrighted; only run games you own or that are freely distributable.
